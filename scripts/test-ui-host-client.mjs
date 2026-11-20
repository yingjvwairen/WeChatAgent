import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { UiHostClient, WindowsUiDriver } from './ui-host-client.mjs';

test('type authorization stays local and a revoked callback never enters the host pipe',async()=>{
  let calls=0,allowed=true;
  const driver=new WindowsUiDriver({client:{async request(action,values){calls++;assert.equal(action,'type');assert.equal(Object.hasOwn(values,'canInput'),false);assert.equal(Object.values(values).some(value=>typeof value==='function'),false);return{performed:true,attempted:true};}}});
  const job={account:'fixture_account',target:'filehelper'};
  assert.equal((await driver.typeGrapheme(job,{text:'字'},{canInput:()=>allowed})).performed,true);
  allowed=false;assert.equal((await driver.typeGrapheme(job,{text:'字'},{canInput:()=>allowed})).attempted,false);assert.equal(calls,1);
});
import { runUiDemo } from './ui-preview.mjs';

function fixture(t, reply, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-host-client-'));
  const configFile = path.join(directory, 'binding.json'); fs.writeFileSync(configFile, '{}');
  const calls = []; let child;
  const client = new UiHostClient({ executable: process.execPath, configFile, timeoutMs: 1000, ...options,
    spawnImpl(exe, args, settings) {
      calls.push({ exe, args, settings }); child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
      child.kill = () => { child.killed = true; child.emit('exit', 0); };
      let buffered = '';
      child.stdin.on('data', chunk => { buffered += chunk; let end; while ((end = buffered.indexOf('\n')) >= 0) { const request = JSON.parse(buffered.slice(0, end)); buffered = buffered.slice(end + 1); reply(request, child); } });
      return child;
    } });
  t.after(() => { client.close(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert(path.basename(directory).startsWith('ui-host-client-')); fs.rmSync(directory, { recursive: true, force: true }); });
  return { client, calls, child: () => child };
}
const answer = (request, child, result) => child.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + '\n');

test('native input defaults off before process launch, while read-only observations use a hidden non-shell host', async t => {
  const f = fixture(t, (request, child) => answer(request, child, { ready: false, reason: 'UI_BINDING_REQUIRED' }));
  await assert.rejects(f.client.request('type', { text: 'fixture' }), { code: 'UI_INPUT_DISABLED', attempted: false });
  assert.equal(f.calls.length, 0);
  assert.equal((await f.client.request('observe')).ready, false);
  assert.deepEqual(f.calls[0].args.slice(0, 1), ['--config']);
  assert(!f.calls[0].args.includes('--enable-input')); assert.equal(f.calls[0].settings.windowsHide, true); assert.equal(f.calls[0].settings.shell, false);
});

test('response framing preserves split Unicode bytes and associates replies by request ID', async t => {
  const f = fixture(t, (request, child) => { const bytes = Buffer.from(JSON.stringify({ id: request.id, ok: true, result: { draft: '你好🙂' } }) + '\n'); for (const byte of bytes) child.stdout.write(Buffer.from([byte])); });
  assert.equal((await f.client.request('observe')).draft, '你好🙂');
});

test('a timeout kills the host and never silently starts a replacement for an uncertain action', async t => {
  const f = fixture(t, () => {}, { enableInput: true, timeoutMs: 20 });
  await assert.rejects(f.client.request('submit'), { code: 'UI_HOST_TIMEOUT' });
  assert.equal(f.child().killed, true);
  await assert.rejects(f.client.request('observe'), { code: 'UI_HOST_TIMEOUT' });
  assert.equal(f.calls.length, 1);
});

test('malformed and oversized native output fail closed without leaking provider text', async t => {
  for (const output of ['private diagnostic is not JSON\n', 'x'.repeat(1025)]) {
    const f = fixture(t, (_request, child) => child.stdout.write(output), { maxResponseBytes: 1024 });
    await assert.rejects(f.client.request('inspect'), error => /^UI_HOST_(PROTOCOL_INVALID|RESPONSE_TOO_LARGE)$/.test(error.code) && !error.message.includes('private'));
    assert.equal(f.child().killed, true);
  }
});

test('driver distinguishes definite guard refusal from uncertain input failures', async () => {
  const job = { account: 'fixture-account', target: 'fixture-target' };
  let attempted = false;
  const driver = new WindowsUiDriver({ client: { async request() { throw Object.assign(Error('UI_ACTIVITY_CHANGED'), { code: 'UI_ACTIVITY_CHANGED', ...(attempted ? {} : { attempted: false }) }); } } });
  assert.deepEqual(await driver.typeGrapheme(job, { text: '字' }), { performed: false, attempted: false, reason: 'UI_ACTIVITY_CHANGED' });
  attempted = true; await assert.rejects(driver.typeGrapheme(job, { text: '字' }), { code: 'UI_ACTIVITY_CHANGED' });
  assert.deepEqual(await driver.submit(job, {}), { performed: false, attempted: false, reason: 'UI_SUBMIT_DISABLED' });
  assert.throws(() => new WindowsUiDriver({ client: {}, allowSubmit: true }), /UI_DRIVER_OPTIONS_INVALID/);
  assert.throws(() => new WindowsUiDriver({ client: { request() {} }, allowSubmit: true }), /UI_RECEIPT_PROVIDER_REQUIRED/);
  const controller = new AbortController();
  const withReceipt = new WindowsUiDriver({ client: { request() {} }, receipt: async (receivedJob, options) => {
    assert.equal(receivedJob, job); assert.equal(options.signal, controller.signal); return { confirmed: false };
  } });
  assert.deepEqual(await withReceipt.receipt(job, { signal: controller.signal }), { confirmed: false });
});

test('host guard errors preserve attempted false and an output-only host cannot report input ready', async t => {
  const f = fixture(t, (request, child) => child.stdout.write(JSON.stringify({ id: request.id, ok: false, error: { code: 'UI_HUMAN_ACTIVE', attempted: false } }) + '\n'), { enableInput: true });
  const driver = new WindowsUiDriver({ client: f.client });
  assert.deepEqual(await driver.typeGrapheme({ account: 'fixture', target: 'fixture' }, { text: '字' }), { performed: false, attempted: false, reason: 'UI_HUMAN_ACTIVE' });
  const readonly = new WindowsUiDriver({ client: { async request() { return { ready: true, foreground: true, idleMs: 20000, inputEnabled: false }; } } });
  assert.equal((await readonly.observe({ account: 'fixture', target: 'fixture' })).ready, false);
});

test('native startup failures retain a bounded diagnostic without claiming an input was definitely rejected', async t => {
  const f = fixture(t, (_request, child) => child.stdout.write(JSON.stringify({ id: null, ok: false, error: { code: 'UI_CONFIG_INVALID', attempted: false } }) + '\n'));
  await assert.rejects(f.client.request('inspect'), error => error.code === 'UI_CONFIG_INVALID' && error.attempted === undefined);
  assert.equal(f.child().killed, true);
  const unavailable = new WindowsUiDriver({ client: { async request() { return { ready: false, reason: 'UI_EDITOR_UNAVAILABLE', foreground: true, idleMs: 20000, inputEnabled: false }; } } });
  assert.equal((await unavailable.observe({ account: 'fixture', target: 'fixture' })).reason, 'UI_EDITOR_UNAVAILABLE');
});

test('development demo exercises pause, restart and draft conflicts without launching native input', async () => {
  const result = await runUiDemo();
  assert.equal(result.mode, 'offline-simulation'); assert.equal(result.realMessagesSent, 0); assert.equal(result.windowsOpened, 0); assert.equal(result.passed, 6);
});
