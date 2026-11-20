import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkLocalReader, validateProtectedCredential } from './reader-local-setup.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const fault = code => Object.assign(new Error(code), { code, localApiFault: true });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function noLinks(file) {
  let current = path.resolve(file);
  for (;;) {
    const info = fs.lstatSync(current, { throwIfNoEntry: false });
    if (info?.isSymbolicLink()) throw fault('READER_LOCAL_API_LINK_REJECTED');
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(file);
    current = parent;
  }
}

function removeSession(folder, directory) {
  if (!folder) return;
  noLinks(folder); noLinks(directory);
  if (!samePath(path.dirname(folder), directory) || !/^api-session-[A-Za-z0-9_-]{6,64}$/.test(path.basename(folder))) throw fault('READER_LOCAL_API_CLEANUP_FAILED');
  if (!fs.existsSync(folder)) return;
  function inspect(current) {
    noLinks(current);
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, item.name);
      if (item.isSymbolicLink()) throw fault('READER_LOCAL_API_LINK_REJECTED');
      if (item.isDirectory()) inspect(file);
      else noLinks(file);
    }
  }
  inspect(folder);
  // The checked absolute target is a newly owned, immediate state/reader child.
  fs.rmSync(folder, { recursive: true, force: false });
}

async function jsonRequest(port, token, route, { method = 'GET', authenticated = true, fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(`http://127.0.0.1:${port}${route}`, {
    method, headers: authenticated ? { Authorization: `Bearer ${token}` } : {}, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2500)]) : AbortSignal.timeout(2500),
  });
  const reader = response.body?.getReader();
  if (!reader) throw fault('READER_LOCAL_API_HTTP_INVALID');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw fault('READER_LOCAL_API_HTTP_INVALID');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fault('READER_LOCAL_API_HTTP_INVALID'); }
  if (!object(body)) throw fault('READER_LOCAL_API_HTTP_INVALID');
  return { status: response.status, body };
}

function validScope(scope, account) {
  return object(scope) && scope.success === true && scope.backend === 'weflow-cli-nt' && typeof scope.ownWxid === 'string' &&
    scope.ownWxid.length > 0 && scope.ownWxid.length <= 256 && scope.accountDirectory === account.myWxid &&
    scope.receiptOnly === true && scope.automaticReplies === false && scope.desktopAccountVerified === false;
}

async function verifyHttp(packet, account, token, fetchImpl, signal) {
  if (!Number.isInteger(packet.port) || packet.port < 1 || packet.port > 65535 || !validScope(packet.scope, account)) throw fault('READER_LOCAL_API_PROTOCOL_INVALID');
  const request = (route, options = {}) => jsonRequest(packet.port, token, route, { fetchImpl, signal, ...options });
  const checked = await request('/api/v1/reader/status');
  if (checked.status !== 200 || !validScope(checked.body, account) || checked.body.ownWxid !== packet.scope.ownWxid) throw fault('READER_LOCAL_API_SCOPE_INVALID');
  const fromTime = Math.floor(Date.now() / 1000);
  const receipt = await request(`/api/v1/messages?talker=filehelper&receipt_scope=1&from_time=${fromTime}`);
  const scope = receipt.body.scope;
  if (receipt.status !== 200 || receipt.body.success !== true || !object(scope) || scope.version !== 1 || scope.complete !== true ||
      scope.talker !== 'filehelper' || scope.accountWxid !== packet.scope.ownWxid || scope.accountDirectory !== account.myWxid ||
      scope.fromTime !== fromTime || !Number.isInteger(scope.throughTime) || scope.throughTime < fromTime || scope.throughTime > Math.floor(Date.now() / 1000) ||
      !Array.isArray(receipt.body.messages) || receipt.body.messages.length > 500) throw fault('READER_LOCAL_API_SCOPE_INVALID');
  const unauthorized = await request('/api/v1/reader/status', { authenticated: false });
  const write = await request('/api/v1/reader/status', { method: 'POST' });
  const endpoint = await request('/api/v1/contacts');
  const events = await request('/api/v1/push/messages');
  const target = await request(`/api/v1/messages?talker=other-target&receipt_scope=1&from_time=${fromTime}`);
  if (unauthorized.status !== 401 || write.status !== 405 || endpoint.status !== 404 || events.status !== 404 || target.status !== 403) throw fault('READER_LOCAL_API_BOUNDARY_FAILED');
  return { authenticatedStatus: true, readReceiptWindow: true, unauthorizedRejected: true, writeRejected: true, otherEndpointRejected: true, eventsRejected: true, otherTargetRejected: true, port: packet.port };
}

/** Dependency injection is for offline tests. CLI always uses the fixed local Reader binding. */
async function localApiSession({ mode, callback, expectedAccountRef, signal, root = projectRoot, check = checkLocalReader, spawnImpl = spawn, fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  if (!['check', 'probe', 'session'].includes(mode) || mode === 'session' && typeof callback !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 4000 || timeoutMs > 30000 ||
      expectedAccountRef !== undefined && !/^[a-f0-9]{64}$/.test(expectedAccountRef)) throw fault('READER_LOCAL_API_ARGUMENTS_INVALID');
  if (signal?.aborted) throw fault('READER_LOCAL_API_CANCELLED');
  const directory = noLinks(path.join(root, 'state/reader'));
  const lock = noLinks(path.join(directory, 'api.lock'));
  const lease = crypto.randomUUID();
  let locked = false, session, child, childClosed = false, deadline, forceTimer, pending = '', bytes = 0, stderrBytes = 0;
  let result, received = false, stopped = false, verification, failure, callbackFinished = false, exitInfo;
  const controller = new AbortController();
  let resolveClose;
  const closed = new Promise(resolve => { resolveClose = resolve; });
  let rejectFailure;
  const failed = new Promise((_, reject) => { rejectFailure = reject; });
  failed.catch(() => {});
  function fail(error) {
    if (failure) return;
    failure = error?.localApiFault ? error : fault('READER_LOCAL_API_FAILED');
    controller.abort();
    rejectFailure(failure);
  }
  const cancel = () => fail(fault('READER_LOCAL_API_CANCELLED'));
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const binding = check({ root });
    if (expectedAccountRef !== undefined && binding.account.accountRef !== expectedAccountRef) throw fault('READER_LOCAL_API_BINDING_CHANGED');
    if (!binding.cached) throw fault('READER_LOCAL_API_CREDENTIAL_CACHE_REQUIRED');
    validateProtectedCredential(binding.cached, binding.account.accountRef);
    try { fs.writeFileSync(lock, JSON.stringify({ version: 1, pid: process.pid, lease }), { flag: 'wx', mode: 0o600 }); locked = true; }
    catch { throw fault('READER_LOCAL_API_BUSY'); }
    session = fs.mkdtempSync(path.join(directory, 'api-session-'));
    fs.chmodSync(session, 0o700);
    noLinks(session);
    const token = crypto.randomBytes(32).toString('hex');
    const request = { version: 1, mode, accountRef: binding.account.accountRef, dbPath: binding.account.dbPath, myWxid: binding.account.myWxid,
      protectedKey: binding.cached.protectedKey, sessionRoot: session, token, maximumMs: Math.min(25000, timeoutMs - 3000) };
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['PYTHONPATH', 'PYTHONHOME'].includes(key.toUpperCase())));
    const expiresAt = Date.now() + request.maximumMs - 250;
    child = spawnImpl(binding.python, ['-I', '-B', path.join(root, 'scripts/reader-local-api.py')], { cwd: root, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    child.on('error', () => fail(fault('READER_LOCAL_API_START_FAILED')));
    child.on('close', (code, signal) => { childClosed = true; exitInfo = { code, signal }; if (mode === 'session' && !callbackFinished) fail(fault('READER_LOCAL_API_SESSION_ENDED')); resolveClose(exitInfo); });
    child.stdin.on('error', () => fail(fault('READER_LOCAL_API_PIPE_FAILED')));
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 65536) fail(fault('READER_LOCAL_API_PROTOCOL_INVALID')); });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 65536) { fail(fault('READER_LOCAL_API_PROTOCOL_INVALID')); return; }
      pending += chunk.toString('utf8');
      for (;;) {
        const end = pending.indexOf('\n'); if (end < 0) break;
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        let packet;
        try { packet = JSON.parse(line); } catch { fail(fault('READER_LOCAL_API_PROTOCOL_INVALID')); return; }
        if (!object(packet) || packet.ok !== true) { fail(fault('READER_LOCAL_API_CHILD_FAILED')); return; }
        if (packet.type === 'stopped' && mode !== 'check' && received && !stopped) { stopped = true; if (mode === 'session' && !callbackFinished) fail(fault('READER_LOCAL_API_SESSION_ENDED')); continue; }
        if (received || packet.type !== (mode === 'check' ? 'check' : 'ready')) { fail(fault('READER_LOCAL_API_PROTOCOL_INVALID')); return; }
        received = true;
        if (mode === 'check') {
          if (packet.databaseVerified !== true || packet.filehelperOnly !== true || packet.receiptWindowComplete !== true || packet.networkStarted !== false || typeof packet.contactNamesLoaded !== 'boolean') {
            fail(fault('READER_LOCAL_API_PROTOCOL_INVALID')); return;
          }
          result = { databaseVerified: true, contactNamesLoaded: packet.contactNamesLoaded, filehelperOnly: true, receiptWindowComplete: true, networkStarted: false };
        } else {
          verification = (async () => {
            const value = await verifyHttp(packet, binding.account, token, fetchImpl, controller.signal);
            if (failure || controller.signal.aborted || childClosed) return;
            const current = check({ root });
            if (current.account.accountRef !== binding.account.accountRef || current.cached?.protectedKey !== binding.cached.protectedKey) throw fault('READER_LOCAL_API_BINDING_CHANGED');
            if (mode === 'session') {
              if (Date.now() >= expiresAt) throw fault('READER_LOCAL_API_TIMEOUT');
              const access = Object.freeze({ baseUrl: `http://127.0.0.1:${packet.port}`, token, accountWxid: packet.scope.ownWxid,
                accountDirectory: binding.account.myWxid, accountRef: binding.account.accountRef, signal: controller.signal, expiresAt });
              try { await callback(access); } catch { throw fault('READER_LOCAL_API_CALLBACK_FAILED'); }
              if (failure || controller.signal.aborted || childClosed) return;
              if (Date.now() >= expiresAt) throw fault('READER_LOCAL_API_TIMEOUT');
              callbackFinished = true;
              // Callback results may contain private receipts or tokens. The
              // caller may retain them in memory; never spread them into reports.
              const { port, ...checks } = value;
              result = { ...checks, callbackCompleted: true, filehelperOnly: true };
              controller.abort();
            } else result = value;
            child.stdin.end();
          })().catch(fail);
        }
      }
    });
    deadline = setTimeout(() => fail(fault('READER_LOCAL_API_TIMEOUT')), mode === 'session' ? Math.max(1, expiresAt - Date.now()) : timeoutMs - 1500);
    child.stdin.write(JSON.stringify(request) + '\n');
    if (mode === 'check') child.stdin.end();
    if (signal?.aborted) cancel();
    const exit = await Promise.race([closed, failed]);
    if (verification) await Promise.race([verification, failed]);
    if (failure) throw failure;
    if (exit.code !== 0 || exit.signal || pending.trim() || !received || !result || (mode !== 'check' && !stopped)) throw fault('READER_LOCAL_API_INCOMPLETE');
    const current = check({ root });
    if (current.account.accountRef !== binding.account.accountRef || current.cached?.protectedKey !== binding.cached.protectedKey) throw fault('READER_LOCAL_API_BINDING_CHANGED');
    return { ok: true, mode: `reader-local-api-${mode}`, ...result, processStopped: true, receiptOnly: true, automaticReplies: false,
      liveAccountVerified: false, newMessageReceiptVerified: false, readyForUiSend: false, productionConfigurationWritten: false, keyComponentLoaded: false };
  } catch (error) {
    throw error?.localApiFault ? error : fault('READER_LOCAL_API_FAILED');
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', cancel);
    controller.abort();
    if (child && !childClosed) {
      child.stdin.end();
      forceTimer = setTimeout(() => { if (!childClosed) child.kill(); }, 400);
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 1200))]);
      clearTimeout(forceTimer);
    }
    // Never release ownership if the child may still hold a database or listening socket.
    if (child && !childClosed) throw fault('READER_LOCAL_API_CLEANUP_UNCONFIRMED');
    // A killed venv launcher is not proof its interpreter stopped. Private
    // callback sessions require Python's normal stop acknowledgement and exit;
    // otherwise retain the lease/configuration for explicit recovery.
    if (mode === 'session' && child && (!stopped || exitInfo?.code !== 0 || exitInfo?.signal)) throw fault('READER_LOCAL_API_CLEANUP_UNCONFIRMED');
    try {
      removeSession(session, directory);
      if (locked) {
        noLinks(lock);
        const info = fs.statSync(lock, { throwIfNoEntry: false });
        if (!info?.isFile() || info.size > 1024 || JSON.parse(fs.readFileSync(lock, 'utf8')).lease !== lease) throw fault('READER_LOCAL_API_CLEANUP_FAILED');
        fs.unlinkSync(lock);
      }
    } catch { throw fault('READER_LOCAL_API_CLEANUP_FAILED'); }
  }
}

export function runLocalApi(options = {}) {
  if (!['check', 'probe'].includes(options.mode)) return Promise.reject(fault('READER_LOCAL_API_ARGUMENTS_INVALID'));
  return localApiSession(options);
}

/** Short-lived private capability. Callers must honor signal/expiresAt before any
 * action; JavaScript cannot forcibly cancel a callback. No UI is invoked here. */
export function withLocalReceiptApi(options = {}) {
  return localApiSession({ ...options, mode: 'session' });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  (async () => {
    if (args.length !== 1 || !['--check', '--probe'].includes(args[0])) throw fault('READER_LOCAL_API_ARGUMENTS_INVALID');
    console.log(JSON.stringify(await runLocalApi({ mode: args[0].slice(2) }), null, 2));
  })().catch(error => { console.error(error?.localApiFault ? error.code : 'READER_LOCAL_API_FAILED'); process.exitCode = 1; });
}
