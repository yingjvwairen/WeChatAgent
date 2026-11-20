import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createUiReaderMediaProxy } from './ui-reader-media-proxy.mjs';
import { fetchBoundReaderMedia, fetchBoundReaderFile } from '../packages/dsh-social-bridge-plugin/reader-media-access.mjs';
import {FileTransfers} from '../packages/dsh-social-bridge-plugin/file-transfers.mjs';
import { imageBlocks } from '../packages/dsh-social-bridge-plugin/image-input.mjs';

const accountRef = 'a'.repeat(64), grantId = 'b'.repeat(64), readerToken = 'c'.repeat(64), adapterToken = 'd'.repeat(64), imageId = 'e'.repeat(64);
const wxid = 'fixture_media_friend', id = String(crypto.createHash('sha256').update(wxid).digest().readBigUInt64BE(0) % 2147483647n + 1n), key = 'wechat:private:' + id;
const write = (root, relative, value) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const image = () => { const bytes = Buffer.from('fixture image transport'); return { imageId, conversationKey: key, mime: 'image/jpeg', b64: bytes.toString('base64'), sha256: crypto.createHash('sha256').update(bytes).digest('hex'), sourceQuality: 'thumbnail', _private: readerToken }; };
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-ui-media-proxy-'));
  const accountRef=options.files?crypto.createHash('sha256').update(path.join(fs.realpathSync(root),'wechat-cache').toLowerCase()).digest('hex'):'a'.repeat(64);
  const wxid=options.group?'fixture_media_room@chatroom':'fixture_media_friend',id=String(crypto.createHash('sha256').update(wxid).digest().readBigUInt64BE(0)%2147483647n+1n),key='wechat:'+(options.group?'group':'private')+':'+id;
  const generation = new AbortController(), readerLifetime = new AbortController(); let finishReader, currentVersion = 1, calls = 0, response = ()=>({...image(),conversationKey:key});
  const readerServer = http.createServer((req, res) => {
    calls++; assert.equal(req.headers.authorization, 'Bearer ' + readerToken); assert.equal(req.headers['x-wechatagent-target-grant'], undefined);
    const url = new URL(req.url, 'http://127.0.0.1'); assert.equal(url.searchParams.get('conversationKey'), key);
    const send = body => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (options.onReaderRequest) options.onReaderRequest(req, res, send); else send(response(url.pathname,url.searchParams));
  });
  const readerPort = await listen(readerServer);
  const proxy = createUiReaderMediaProxy({ token: adapterToken, getPort: () => adapterServer.address().port, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  const adapterServer = http.createServer(async (req, res) => { if (!await proxy.handle(req, res)) res.writeHead(404).end('{}'); });
  const adapterPort = await listen(adapterServer);
  const selection = version => ({ schemaVersion: 1, accountRef, version, updatedAt: 1, automaticReplies: false, targets: [{ wxid, id, label: 'fixture', alias: '', grantId }] });
  write(root, 'config/wechatagent.json', { runtime: { sender: 'wechat-ui' }, ports: { adapter: adapterPort } });
  write(root, 'state/social-dsh-token.txt', adapterToken); write(root, 'state/weflow/active-account.json', { id: accountRef }); write(root, 'state/reader-service/selection.json', selection(1));
  // A stale, valid legacy endpoint must never be chosen for current UI mode.
  write(root, 'state/wechat-io-config.json', { reader_base_url: `http://127.0.0.1:${readerPort}`, reader_token: 'stale-token-must-not-be-used' });
  const reader = { baseUrl: `http://127.0.0.1:${readerPort}`, token: readerToken, accountRef, selectionVersion: 1, targets: [wxid], signal: readerLifetime.signal, done: new Promise(resolve => { finishReader = resolve; }) };
  const release = proxy.publish({ reader, accountRef, selectionVersion: 1, targets: selection(1).targets, signal: generation.signal,
    validateCurrent: () => { if (currentVersion !== 1) throw Object.assign(new Error('fixture scope changed'), { code: 'UI_MEDIA_SCOPE_REVOKED' }); } });
  t.after(async () => { proxy.close(); generation.abort(); readerLifetime.abort(); finishReader(); for (const server of [readerServer, adapterServer]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const headers = { Authorization: 'Bearer ' + adapterToken, 'X-WeChatAgent-Account': accountRef, 'X-WeChatAgent-Selection-Version': '1', 'X-WeChatAgent-Target-Grant': grantId };
  const url = `http://127.0.0.1:${adapterPort}/images/${imageId}?conversationKey=${encodeURIComponent(key)}`;
  return { root, proxy, reader, readerLifetime, generation, release, finishReader, headers, url, readerPort, adapterPort, key,
    setVersion(version) { currentVersion = version; write(root, 'state/reader-service/selection.json', selection(version)); },
    setResponse(value) { response = value; }, get calls() { return calls; } };
}

test('selected sender receives a verified attachment via its group grant and private Reader capability',async t=>{
  const f=await fixture(t,{files:true,group:true}),sender='wxid_fixture_sender',accountRoot=path.join(f.root,'wechat-cache');
  const bytes=Buffer.from('fixture attachment'),name='file.txt',source=path.join(accountRoot,'msg/file/2026-11',name),cwd=path.join(f.root,'project');
  fs.mkdirSync(path.dirname(source),{recursive:true});fs.mkdirSync(cwd);fs.writeFileSync(source,bytes);
  const project=JSON.parse(fs.readFileSync(path.join(f.root,'config/wechatagent.json')));
  project.wechat={whitelist:{private:[],groups:[f.key.split(':').at(-1)]},workModes:{[f.key]:'assistant'},assistant:{fileTransferChats:{[f.key]:true},administrators:[sender]}};
  write(f.root,'config/wechatagent.json',project);
  const file={id:imageId,conversationKey:f.key,senderWxid:sender,status:'ready',name,size:bytes.length,accountRoot,path:source,
    md5:crypto.createHash('md5').update(bytes).digest('hex'),sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
  f.setResponse((route,query)=>{assert.equal(route,'/api/v1/files/'+imageId);assert.equal(query.get('senderWxid'),sender);return file;});
  const receive=()=>new FileTransfers(f.root).receive({id:imageId,key:f.key,sender,cwd});
  const result=await receive();assert.equal(result.status,'ready');assert.deepEqual(fs.readFileSync(path.join(cwd,result.path)),bytes);
  f.setResponse(()=>({...file,senderWxid:'another_sender'}));await assert.rejects(receive(),/FILE_/);
  f.setResponse(()=>({...file,md5:'f'.repeat(32)}));await assert.rejects(receive(),/FILE_INTEGRITY_FAILED/);
  f.setResponse(()=>({...file,readerToken,status:'not_downloaded'}));
  const pending=await fetchBoundReaderFile(f.root,imageId,f.key,sender);
  assert.equal(pending.file.path,undefined);assert.equal(pending.file.readerToken,undefined);
  f.setVersion(2);assert.throws(pending.assertCurrent,/FILE_READER_SCOPE_REVOKED/);
  await assert.rejects(receive(),/FILE_/);
});

test('selected group media stays room-scoped through plugin and proxy and revokes with selection',async t=>{
  const f=await fixture(t,{group:true});
  const result=await fetchBoundReaderMedia(f.root,'images',imageId,f.key);
  assert.equal(result.conversationKey,f.key);assert.equal(f.calls,1);
  await assert.rejects(fetchBoundReaderMedia(f.root,'images',imageId,f.key.replace(':group:',':private:')),/READER_SCOPE_REVOKED/);
  f.setVersion(2);await assert.rejects(fetchBoundReaderMedia(f.root,'images',imageId,f.key),/READER_NOT_READY/);
});

test('current UI image admission uses only the live private proxy and never returns Reader credentials', async t => {
  const f = await fixture(t), saved = [];
  const ctx = { get: name => name === 'llm' ? { resolveModelInfo: async () => ({ inputModalities: ['image'] }) } : { saveImage: async value => { saved.push(value); return { attachmentId: 'fixture' }; } } };
  const blocks = await imageBlocks(ctx, f.root, key, [{ id: imageId }], 'fixture', 'fixture');
  assert.deepEqual(blocks.map(item => item.type), ['text','image']); assert.equal(saved.length, 1); assert.equal(f.calls, 1);
  const content = await fetchBoundReaderMedia(f.root, 'images', imageId, key);
  assert.equal(content._private, undefined); assert(!JSON.stringify(content).includes(readerToken)); assert(!JSON.stringify(content).includes(adapterToken));
  const files = fs.readdirSync(path.join(f.root, 'state')); assert(!files.some(name => /endpoint|capability/.test(name)));
});

test('audio and video use the same scoped transport', async t => {
  const f = await fixture(t); f.setResponse(() => ({ version: 1, mediaId: imageId, conversationKey: key, kind: 'audio', sourceSha256: 'f'.repeat(64), durationMs: 1500, audioPresent: true,
    frames: [], transcript: { status: 'ready', text: 'fixture audio', segments: [], automated: true }, semanticAnalysis: 'not_performed', readerToken }));
  const result = await fetchBoundReaderMedia(f.root, 'media', imageId, key); assert.equal(result.transcript.text, 'fixture audio'); assert.equal(result.readerToken, undefined); assert.equal(f.calls, 1);
});

test('authentication, origin, exact route and selection headers reject requests before Reader access', async t => {
  const f = await fixture(t);
  for (const [headers, expected] of [[{},401], [{ ...f.headers, Authorization: 'Bearer wrong' },401], [{ ...f.headers, Origin: '' },403],
    [{ ...f.headers, 'X-WeChatAgent-Account': 'f'.repeat(64) },403], [{ ...f.headers, 'X-WeChatAgent-Selection-Version': '2' },403], [{ ...f.headers, 'X-WeChatAgent-Target-Grant': 'f'.repeat(64) },403]]) {
    const response = await fetch(f.url, { headers }); assert.equal(response.status, expected); await response.body.cancel();
  }
  for (const suffix of ['&conversationKey=' + encodeURIComponent(key), '&extra=1']) { const response = await fetch(f.url + suffix, { headers: f.headers }); assert.equal(response.status, 400); await response.body.cancel(); }
  const post = await fetch(f.url, { method: 'POST', headers: f.headers }); assert.equal(post.status, 405); await post.body.cancel(); assert.equal(f.calls, 0);
});

test('selection changes are checked immediately, before the service polling interval', async t => {
  const f = await fixture(t); f.setVersion(2);
  const response = await fetch(f.url, { headers: f.headers }); assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: 'UI_MEDIA_SCOPE_REVOKED' }); assert.equal(f.calls, 0);
  await assert.rejects(fetchBoundReaderMedia(f.root, 'images', imageId, key), /IMAGE_READER_NOT_READY/); assert.equal(f.calls, 0);
});

test('revocation while the Reader is responding discards all image bytes', async t => {
  let releaseResponse, reached; const pending = new Promise(resolve => { reached = resolve; });
  const f = await fixture(t, { onReaderRequest(_req, _res, send) { releaseResponse = () => send(image()); reached(); } });
  const task = fetch(f.url, { headers: f.headers }); await pending; f.setVersion(2); releaseResponse();
  const response = await task, result = await response.json(); assert.equal(response.status, 403); assert.equal(result.b64, undefined); assert(!JSON.stringify(result).includes(readerToken));
});

test('Reader or generation shutdown immediately invalidates the capability and aborts in-flight reads', async t => {
  let reached; const pending = new Promise(resolve => { reached = resolve; });
  const f = await fixture(t, { onReaderRequest() { reached(); } });
  const task = fetchBoundReaderMedia(f.root, 'images', imageId, key); await pending; f.readerLifetime.abort();
  await assert.rejects(task, /IMAGE_READER_NOT_READY/);
  const response = await fetch(f.url, { headers: f.headers }); assert.equal(response.status, 503); await response.body.cancel(); assert.equal(f.calls, 1);
});

test('wrong-conversation results and private upstream errors cannot escape the proxy', async t => {
  const f = await fixture(t); f.setResponse(() => ({ ...image(), conversationKey: 'wechat:private:999' }));
  const response = await fetch(f.url, { headers: f.headers }); assert.equal(response.status, 403); const result = await response.json(); assert.equal(result.b64, undefined); assert.equal(result.error, 'UI_MEDIA_CONVERSATION_MISMATCH');
});

test('UI transport never falls back after shutdown or missing account binding', async t => {
  const f = await fixture(t); f.release(); await assert.rejects(fetchBoundReaderMedia(f.root, 'images', imageId, key), /IMAGE_READER_NOT_READY/); assert.equal(f.calls, 0);
  write(f.root, 'state/weflow/active-account.json', { id: 'f'.repeat(64) }); await assert.rejects(fetchBoundReaderMedia(f.root, 'images', imageId, key), /IMAGE_READER_SCOPE_REVOKED/); assert.equal(f.calls, 0);
});

test('helper refuses legacy unscoped endpoints and arbitrary media identifiers without a network request', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-loopback-')); t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  write(root, 'state/wechat-io-config.json', { reader_base_url: 'https://example.com', reader_token: 'fixture' });
  await assert.rejects(fetchBoundReaderMedia(root, 'images', imageId, key), /READER_NOT_READY/);
  await assert.rejects(fetchBoundReaderMedia(root, 'images', '../secret', key), /REFERENCE_INVALID/);
  await assert.rejects(fetchBoundReaderMedia(root, 'files', imageId, key), /REFERENCE_INVALID/);
});

test('response-size rejection cancels a declared oversized Reader body', async t => {
  let cancelled = false;
  const f = await fixture(t, { fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Length': String(6 * 1024 * 1024 + 1) } }) });
  const response = await fetch(f.url, { headers: f.headers }); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'UI_MEDIA_RESPONSE_LIMIT' }); assert.equal(cancelled, true); assert.equal(f.calls, 0);
});

test('a client account or token change during response admission invalidates the returned bytes', async t => {
  const f = await fixture(t);
  f.setResponse(() => { write(f.root, 'state/weflow/active-account.json', { id: 'f'.repeat(64) }); return image(); });
  await assert.rejects(fetchBoundReaderMedia(f.root, 'images', imageId, key), /IMAGE_READER_SCOPE_REVOKED/);
  write(f.root, 'state/weflow/active-account.json', { id: accountRef });
  f.setResponse(() => { write(f.root, 'state/social-dsh-token.txt', 'f'.repeat(64)); return image(); });
  await assert.rejects(fetchBoundReaderMedia(f.root, 'images', imageId, key), /IMAGE_READER_SCOPE_REVOKED/); assert.equal(f.calls, 2);
});

test('late completion of an old Reader cannot revoke the new generation', async t => {
  const f = await fixture(t), next = new AbortController(); f.release(); f.setVersion(2);
  const reader = { ...f.reader, selectionVersion: 2, signal: next.signal, done: new Promise(() => {}) };
  f.proxy.publish({ reader, accountRef, selectionVersion: 2, targets: [{ wxid, id, grantId }], signal: next.signal, validateCurrent() {} });
  f.finishReader(); await new Promise(resolve => setImmediate(resolve));
  const content = await fetchBoundReaderMedia(f.root, 'images', imageId, key); assert.equal(content.imageId, imageId); assert.equal(f.calls, 1); next.abort();
});
