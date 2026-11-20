import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareLocalReaderRequest, checkLocalReader, validateProtectedCredential, saveProtectedCredential, connectLocalReader } from './reader-local-setup.mjs';

const accountRef = 'a'.repeat(64);
// Format fixture only: no Windows credential APIs and no real credential material.
const protectedFixture = 'userdpapi:' + Buffer.concat([Buffer.from('01000000d08c9ddf0115d1118c7a00c04fc297eb', 'hex'), Buffer.alloc(48, 7)]).toString('base64');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-reader-local-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('wechat-reader-local-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const directory = path.join(root, 'state/reader'); fs.mkdirSync(directory, { recursive: true });
  const dataRoot = path.join(root, 'synthetic-data'), myWxid = 'wxid_fixture_a123', dbPath = path.join(dataRoot, myWxid);
  for (const file of ['message/message_0.db', 'contact/contact.db']) {
    const target = path.join(dbPath, 'db_storage', file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'synthetic fixture, never opened as a database');
  }
  const discoveryName = `discovery-${randomUUID()}.json`, discoveryFile = path.join(directory, discoveryName);
  const discovery = { schemaVersion: 1, readOnlyDiscovery: true, databaseContentRead: false, processAttached: false, dataRoot,
    accounts: [{ candidate: 'account-1', dbPath, myWxid, ready: true }] };
  fs.writeFileSync(discoveryFile, JSON.stringify(discovery));
  const wechatExecutable = path.join(root, 'Weixin.exe'); fs.writeFileSync(wechatExecutable, 'synthetic executable metadata; never executed');
  const credentials = path.join(directory, 'credentials.json'), requestFile = path.join(directory, 'connection-request.json');
  const binding = { account: { dbPath, myWxid, accountRef, discoverySha256: 'b'.repeat(64) }, python: path.join(directory, 'venv/Scripts/python.exe'),
    request: { wechatExecutable, wechatExecutableSha256: 'c'.repeat(64) }, cached: null };
  return { root, directory, dataRoot, dbPath, myWxid, discoveryName, discoveryFile, discovery, wechatExecutable, credentials, requestFile, binding };
}

test('preparation pins the unique discovery and executable without copying credentials or account names into the request', t => {
  const f = fixture(t);
  const result = prepareLocalReaderRequest(f);
  assert.equal(result.credentialsWritten, false); assert.equal(result.processAttached, false);
  const text = fs.readFileSync(f.requestFile, 'utf8'), request = JSON.parse(text);
  assert.equal(request.autoKey, true); assert.match(request.accountRef, /^[a-f0-9]{64}$/);
  assert.equal(text.includes(f.myWxid), false); assert.equal(Object.hasOwn(request, 'decryptKey'), false);
  assert.equal(fs.existsSync(f.credentials), false);
  assert.throws(() => prepareLocalReaderRequest(f), { code: 'READER_LOCAL_FILE_ALREADY_EXISTS' });
});

test('discovery must contain exactly one eligible account under its declared data root', t => {
  const f = fixture(t);
  f.discovery.accounts.push({ ...f.discovery.accounts[0] }); fs.writeFileSync(f.discoveryFile, JSON.stringify(f.discovery));
  assert.throws(() => prepareLocalReaderRequest(f), { code: 'READER_LOCAL_DISCOVERY_NOT_UNIQUE' });
  f.discovery.accounts.pop(); f.discovery.dataRoot = path.join(f.root, 'different-root'); fs.writeFileSync(f.discoveryFile, JSON.stringify(f.discovery));
  assert.throws(() => prepareLocalReaderRequest(f), { code: 'READER_LOCAL_DISCOVERY_INVALID' });
  assert.equal(fs.existsSync(f.requestFile), false);
});

test('check rejects injected key fields before any component can be loaded', t => {
  const f = fixture(t); prepareLocalReaderRequest(f);
  const request = JSON.parse(fs.readFileSync(f.requestFile)); request.decryptKey = 'e'.repeat(64); fs.writeFileSync(f.requestFile, JSON.stringify(request));
  assert.throws(() => checkLocalReader({ root: f.root }), { code: 'READER_LOCAL_REQUEST_INVALID' });
});

test('check detects discovery and pinned executable changes without opening databases', t => {
  const f = fixture(t); prepareLocalReaderRequest(f);
  const original = fs.readFileSync(f.discoveryFile); fs.appendFileSync(f.discoveryFile, '\n');
  assert.throws(() => checkLocalReader({ root: f.root }), { code: 'READER_LOCAL_DISCOVERY_CHANGED' });
  fs.writeFileSync(f.discoveryFile, original); fs.appendFileSync(f.wechatExecutable, 'changed');
  assert.throws(() => checkLocalReader({ root: f.root }), { code: 'READER_LOCAL_EXECUTABLE_CHANGED' });
});

test('check rejects an unapproved key DLL by hash and never executes the fixture', t => {
  const f = fixture(t); prepareLocalReaderRequest(f);
  const dll = path.join(f.root, 'components/weflow-cli/resources/key/win32/x64/wx_key.dll');
  fs.mkdirSync(path.dirname(dll), { recursive: true }); fs.writeFileSync(dll, 'synthetic fixture, never loaded');
  assert.throws(() => checkLocalReader({ root: f.root }), { code: 'READER_LOCAL_KEY_COMPONENT_CHANGED' });
});

test('only a bounded canonical DPAPI blob may be cached; raw or legacy keys are rejected', t => {
  const f = fixture(t);
  for (const protectedKey of ['e'.repeat(64), 'safe:fixture', 'userdpapi:ZmFrZQ==', protectedFixture + '\n', protectedFixture + 'A']) {
    assert.throws(() => saveProtectedCredential({ root: f.root, accountRef, protectedKey }), { code: 'READER_LOCAL_PROTECTED_CREDENTIAL_REQUIRED' });
    assert.equal(fs.existsSync(f.credentials), false);
  }
  saveProtectedCredential({ root: f.root, accountRef, protectedKey: protectedFixture });
  const cached = JSON.parse(fs.readFileSync(f.credentials));
  assert.equal(validateProtectedCredential(cached, accountRef).protectedKey, protectedFixture);
  assert.deepEqual(Object.keys(cached).sort(), ['accountRef', 'protectedKey', 'savedAt', 'schemaVersion']);
});

test('invalid or another-account credentials never overwrite an existing cache', t => {
  const f = fixture(t); saveProtectedCredential({ root: f.root, accountRef, protectedKey: protectedFixture });
  const original = fs.readFileSync(f.credentials);
  assert.throws(() => saveProtectedCredential({ root: f.root, accountRef, protectedKey: 'd'.repeat(64) }), { code: 'READER_LOCAL_PROTECTED_CREDENTIAL_REQUIRED' });
  assert.throws(() => saveProtectedCredential({ root: f.root, accountRef: 'f'.repeat(64), protectedKey: protectedFixture }), { code: 'READER_LOCAL_PROTECTED_CREDENTIAL_REQUIRED' });
  assert.deepEqual(fs.readFileSync(f.credentials), original);
});

test('connect keeps child results and progress private and only saves a matching protected result', async t => {
  const f = fixture(t), progress = [];
  const result = await connectLocalReader({ root: f.root, check: () => f.binding, onProgress: item => progress.push(item), setup: async input => {
    assert.equal(input.request.wechatExecutable, f.wechatExecutable); assert.equal(input.request.dbPath, f.dbPath);
    assert.equal(Object.hasOwn(input.request, 'decryptKey'), false); assert.equal(input.python, f.binding.python);
    input.onProgress('private fixture ' + protectedFixture + ' ' + f.dbPath);
    return { ok: true, dbPath: f.dbPath, myWxid: f.myWxid, protectedKey: protectedFixture };
  } });
  assert.equal(result.protectedCredentialSaved, true); assert.equal(result.liveAccountVerified, false);
  assert.deepEqual(progress, [{ stage: 'connecting', code: 'READER_LOCAL_WAITING_FOR_LOGIN' }]);
  const publicOutput = JSON.stringify({ result, progress });
  assert.equal(publicOutput.includes(protectedFixture), false); assert.equal(publicOutput.includes(f.myWxid), false);
  assert.equal(fs.existsSync(path.join(f.directory, 'connection.lock')), false);
});

test('cached credentials travel only over the private setup request and failures preserve the cache', async t => {
  const f = fixture(t); saveProtectedCredential({ root: f.root, accountRef, protectedKey: protectedFixture });
  f.binding.cached = JSON.parse(fs.readFileSync(f.credentials)); const original = fs.readFileSync(f.credentials);
  await assert.rejects(connectLocalReader({ root: f.root, check: () => f.binding, setup: async input => {
    assert.equal(input.request.decryptKey, protectedFixture);
    throw new Error('private fixture ' + protectedFixture + ' ' + f.dbPath);
  } }), { code: 'READER_LOCAL_CONNECT_FAILED', message: 'READER_LOCAL_CONNECT_FAILED' });
  assert.deepEqual(fs.readFileSync(f.credentials), original);
  assert.equal(fs.existsSync(path.join(f.directory, 'connection.lock')), false);
});

test('only the fixed component-ready event becomes a login handoff prompt', async t => {
  const f = fixture(t), progress = [];
  await connectLocalReader({ root: f.root, check: () => f.binding, onProgress: item => progress.push(item), setup: async input => {
    input.onProgress('读取组件已就绪，正在等待同一微信账号的数据库初始化。');
    input.onProgress('读取组件已就绪，正在等待同一微信账号的数据库初始化。' + protectedFixture);
    return { ok: true, dbPath: f.dbPath, myWxid: f.myWxid, protectedKey: protectedFixture };
  } });
  assert.deepEqual(progress, [{ stage: 'connecting', code: 'READER_LOCAL_WAITING_FOR_LOGIN' },
    { stage: 'waiting-for-login', code: 'READER_LOCAL_COMPONENT_ATTACHED' }]);
});

test('raw success keys and switched accounts cannot be persisted', async t => {
  const f = fixture(t);
  for (const [patch, code] of [[{ protectedKey: 'e'.repeat(64) }, 'READER_LOCAL_PROTECTED_CREDENTIAL_REQUIRED'],
    [{ myWxid: 'different_fixture' }, 'READER_LOCAL_RESULT_ACCOUNT_MISMATCH']]) {
    await assert.rejects(connectLocalReader({ root: f.root, check: () => f.binding, setup: async () => ({
      ok: true, dbPath: f.dbPath, myWxid: f.myWxid, protectedKey: protectedFixture, ...patch,
    }) }), { code });
    assert.equal(fs.existsSync(f.credentials), false);
  }
});

test('an existing connection lock prevents setup from running', async t => {
  const f = fixture(t); const lock = path.join(f.directory, 'connection.lock'); fs.writeFileSync(lock, 'existing fixture');
  let invoked = false;
  await assert.rejects(connectLocalReader({ root: f.root, check: () => f.binding, setup: async () => { invoked = true; } }), { code: 'READER_LOCAL_CONNECT_BUSY' });
  assert.equal(invoked, false); assert.equal(fs.readFileSync(lock, 'utf8'), 'existing fixture');
});

test('unconfirmed cleanup preserves a recovery lock and blocks another connection', async t => {
  const f = fixture(t);
  await assert.rejects(connectLocalReader({ root: f.root, check: () => f.binding, setup: async () => {
    throw new Error('READER_SETUP_CLEANUP_UNCONFIRMED');
  } }), { code: 'READER_SETUP_CLEANUP_UNCONFIRMED' });
  const lock = JSON.parse(fs.readFileSync(path.join(f.directory, 'connection.lock')));
  assert.equal(lock.state, 'cleanup-unconfirmed'); assert.equal(lock.code, 'READER_SETUP_CLEANUP_UNCONFIRMED');
  let called = false;
  await assert.rejects(connectLocalReader({ root: f.root, check: () => f.binding, setup: async () => { called = true; } }), { code: 'READER_LOCAL_CONNECT_BUSY' });
  assert.equal(called, false); assert.equal(fs.existsSync(f.credentials), false);
});

test('a normal Python timeout with completed cleanup releases the local connection lock', async t => {
  const f = fixture(t);
  await assert.rejects(connectLocalReader({ root: f.root, check: () => f.binding,
    setup: async () => ({ ok: false, code: 'READER_SETUP_TIMEOUT' }) }), { code: 'READER_SETUP_TIMEOUT' });
  assert.equal(fs.existsSync(path.join(f.directory, 'connection.lock')), false);
});
