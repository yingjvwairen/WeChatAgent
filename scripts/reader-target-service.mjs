import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { checkLocalReader, validateProtectedCredential } from './reader-local-setup.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const fault = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const username = value => typeof value === 'string' && value.isWellFormed() && value.length > 0 && value.length <= 256 && !/[\u0000-\u0020\u007f]/u.test(value);
const wireId = value => String(Number(crypto.createHash('sha256').update(value).digest().readBigUInt64BE(0) % 2147483647n + 1n));
function noLinks(file) {
  for (let item = path.resolve(file); ; item = path.dirname(item)) {
    if (fs.lstatSync(item, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('READER_TARGET_LINK_REJECTED');
    if (path.dirname(item) === item) return path.resolve(file);
  }
}
export function validateTargetBinding(value, accountRef) {
  const keys = ['version','accountRef','targetWxid','targetId','alias','displayName','matchedFields','boundAt','autoSend','onScreenVerified'];
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)) || value.version !== 1 ||
      !hex(value.accountRef) || value.accountRef !== accountRef || !username(value.targetWxid) || value.targetWxid === 'filehelper' || value.targetWxid.endsWith('@chatroom') ||
      value.targetId !== wireId(value.targetWxid) || typeof value.alias !== 'string' || value.alias.length > 256 ||
      typeof value.displayName !== 'string' || !value.displayName.length || value.displayName.length > 128 ||
      !Array.isArray(value.matchedFields) || !value.matchedFields.length || value.matchedFields.length > 2 || value.matchedFields.some(v => !['remark','nick_name'].includes(v)) ||
      !Number.isSafeInteger(value.boundAt) || value.boundAt <= 0 || value.autoSend !== false || value.onScreenVerified !== false) throw fault('READER_TARGET_BINDING_INVALID');
  return structuredClone(value);
}
function localBinding(root, check) {
  const value = check({ root });
  if (!value.cached) throw fault('READER_TARGET_CREDENTIAL_REQUIRED');
  validateProtectedCredential(value.cached, value.account.accountRef);
  return value;
}
function common(value, operation) {
  return { version: 1, operation, accountRef: value.account.accountRef, dbPath: value.account.dbPath, myWxid: value.account.myWxid, protectedKey: value.cached.protectedKey };
}
function childProcess(root, binding, spawnImpl) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['PYTHONPATH','PYTHONHOME'].includes(key.toUpperCase())));
  return spawnImpl(binding.python, ['-I','-B',path.join(root, 'scripts/reader-target-service.py')], { cwd: root, env, windowsHide: true, shell: false, stdio: ['pipe','pipe','pipe'] });
}
function unchanged(root, check, binding) {
  const current = localBinding(root, check);
  if (current.account.accountRef !== binding.account.accountRef || current.cached.protectedKey !== binding.cached.protectedKey) throw fault('READER_TARGET_ACCOUNT_CHANGED');
}

async function readContactReply({ request, root, check, spawnImpl, signal, expectedAccountRef }) {
  if (signal?.aborted) throw fault('READER_TARGET_CANCELLED');
  const binding = localBinding(root, check);
  if (expectedAccountRef !== undefined && binding.account.accountRef !== expectedAccountRef) throw fault('READER_TARGET_ACCOUNT_CHANGED');
  const child = childProcess(root, binding, spawnImpl);
  let output = '', bytes = 0, failed;
  const fail = code => { failed ??= fault(code); child.kill(); };
  const abort = () => fail('READER_TARGET_CANCELLED');
  signal?.addEventListener('abort', abort, { once: true });
  const exit = await new Promise(resolve => {
    const timer = setTimeout(() => fail('READER_TARGET_BIND_TIMEOUT'), 27000);
    const hard = setTimeout(() => { fail('READER_TARGET_CLEANUP_UNCONFIRMED'); resolve({ code: null }); }, 29000);
    child.on('error', () => fail('READER_TARGET_START_FAILED'));
    child.stdin.on('error', () => fail('READER_TARGET_PIPE_FAILED'));
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) fail('READER_TARGET_PROTOCOL_INVALID'); });
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) fail('READER_TARGET_PROTOCOL_INVALID'); else output += chunk.toString('utf8'); });
    child.on('close', (code, exitSignal) => { clearTimeout(timer); clearTimeout(hard); resolve({ code, exitSignal }); });
    child.stdin.end(JSON.stringify({ ...common(binding, request.operation), ...request }) + '\n');
    if (signal?.aborted) abort();
  });
  signal?.removeEventListener('abort', abort);
  if (failed) throw failed;
  let result; try { result = JSON.parse(output); } catch { throw fault('READER_TARGET_PROTOCOL_INVALID'); }
  const replyType = { bind: 'binding', catalog: 'catalog', initialize: 'initialized' }[request.operation];
  if (exit.code !== 0 || exit.exitSignal || result.ok !== true || result.type !== replyType || result.accountRef !== binding.account.accountRef) throw fault('READER_TARGET_BIND_FAILED');
  unchanged(root, check, binding);
  return { result, binding };
}

/** Creates/protects only the selection directory; opens no contact database. */
export async function initializeSelectionDirectory({ expectedAccountRef, root = projectRoot,
  check = checkLocalReader, spawnImpl = spawn, signal } = {}) {
  if (!hex(expectedAccountRef)) throw fault('READER_TARGET_ACCOUNT_REQUIRED');
  const { result } = await readContactReply({ root, check, spawnImpl, signal, expectedAccountRef, request: { operation: 'initialize' } });
  const directory = noLinks(path.join(root, 'state/reader-service'));
  if (result.initialized !== true || Object.keys(result).length !== 4 || !fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory())
    throw fault('READER_TARGET_PROTOCOL_INVALID');
  return { initialized: true, directory, automaticReplies: false };
}

function validPrivateSearchMetadata(item){
  // Older sidecars have no name-search evidence. They may still supply a
  // public alias, but cannot authorize a private-name fallback.
  if(Object.keys(item).length===5)return !('searchName' in item)&&!('uniqueSearchName' in item);
  return Object.keys(item).length===7&&typeof item.searchName==='string'&&typeof item.uniqueSearchName==='boolean'&&
    (item.uniqueSearchName?item.searchName.length>0&&item.searchName.length<=128&&item.searchName===item.searchName.trim()&&item.searchName.isWellFormed()&&!/[\u0000-\u001f\u007f]/u.test(item.searchName)&&!item.searchName.endsWith('@chatroom'):item.searchName==='');
}

/** Contact/group metadata for a picker; never log the returned rows. */
export async function readSelectableContacts({ keyword = '', limit = 100, targetWxids = [], expectedAccountRef,
  root = projectRoot, check = checkLocalReader, spawnImpl = spawn, signal } = {}) {
  if (!hex(expectedAccountRef) || typeof keyword !== 'string' || keyword.length > 100 || !keyword.isWellFormed() || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
      !Array.isArray(targetWxids) || targetWxids.length > 32 || targetWxids.some(value => !username(value)) || new Set(targetWxids).size !== targetWxids.length || targetWxids.length > limit)
    throw fault('READER_TARGET_CATALOG_INVALID');
  const { result } = await readContactReply({ root, check, spawnImpl, signal, expectedAccountRef, request: { operation: 'catalog', keyword, limit, targetWxids } });
  if (!Array.isArray(result.contacts) || result.contacts.length > limit || typeof result.truncated !== 'boolean' || result.contacts.some(item => !object(item) ||
      !username(item.wechatId) || item.wechatId === 'filehelper' || item.id !== wireId(item.wechatId) || typeof item.name !== 'string' || item.name.length > 256 ||
      typeof item.alias !== 'string' || item.alias.length > 256 || typeof item.ambiguous !== 'boolean' ||
      (item.wechatId.endsWith('@chatroom') ? Object.keys(item).length !== 8 || item.kind !== 'group' || item.groupName !== item.name || !item.name.trim() || item.name === item.wechatId || item.alias !== '' || typeof item.uniqueSearchName !== 'boolean' || !item.uniqueSearchName && !item.ambiguous : !validPrivateSearchMetadata(item))) ||
      targetWxids.length && (result.truncated || result.contacts.length !== targetWxids.length || result.contacts.some(item => !targetWxids.includes(item.wechatId) || item.ambiguous))) throw fault('READER_TARGET_PROTOCOL_INVALID');
  return { contacts: result.contacts.map(item => ({ ...item })), truncated: result.truncated, accountRef: expectedAccountRef };
}

/** One-time exact display-name selection. Only the saved stable ID authorizes reads. */
export async function bindReaderTarget({ displayName, root = projectRoot, check = checkLocalReader, spawnImpl = spawn, signal } = {}) {
  if (typeof displayName !== 'string' || !displayName.length || displayName.length > 128 || displayName.trim() !== displayName || !displayName.isWellFormed() || /[\u0000-\u001f]/u.test(displayName)) throw fault('READER_TARGET_DISPLAY_NAME_INVALID');
  const { result, binding } = await readContactReply({ root, check, spawnImpl, signal, request: { operation: 'bind', displayName } });
  if (typeof result.matched !== 'boolean') throw fault('READER_TARGET_PROTOCOL_INVALID');
  if (!result.matched) {
    if (!['ambiguous','not-found','ineligible'].includes(result.reason)) throw fault('READER_TARGET_PROTOCOL_INVALID');
    return { matched: false, reason: result.reason, inputSent: false };
  }
  const target = validateTargetBinding(result.binding, binding.account.accountRef);
  if (target.displayName !== displayName) throw fault('READER_TARGET_BINDING_INVALID');
  const file = noLinks(path.join(root, 'state/reader-service/target.json'));
  if (fs.existsSync(file)) {
    const prior = validateTargetBinding(JSON.parse(fs.readFileSync(file, 'utf8')), binding.account.accountRef);
    if (prior.targetWxid !== target.targetWxid) throw fault('READER_TARGET_ALREADY_BOUND');
  } else {
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(target)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.linkSync(temporary, file); // Exclusive publication never overwrites another binding.
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  return { matched: true, unique: true, bindingFile: file, automaticReplies: false, onScreenVerified: false, inputSent: false };
}

function loadTarget(file, root, accountRef) {
  if (typeof file !== 'string' || path.resolve(file) !== path.resolve(root, 'state/reader-service/target.json')) throw fault('READER_TARGET_BINDING_PATH_INVALID');
  noLinks(file);
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > 8192) throw fault('READER_TARGET_BINDING_INVALID');
  try { return validateTargetBinding(JSON.parse(fs.readFileSync(file, 'utf8')), accountRef); }
  catch { throw fault('READER_TARGET_BINDING_INVALID'); }
}
const cursorValid = value => typeof value === 'string' && /^[a-f0-9]{32}:[0-9]{1,16}$/.test(value);
async function verifyService(packet, binding, targets, selectionVersion, token, fetchImpl, signal) {
  if (!object(packet) || packet.type !== 'ready' || packet.ok !== true || !object(packet.scope) || !cursorValid(packet.initialCursor)) throw fault('READER_TARGET_PROTOCOL_INVALID');
  const scope = packet.scope;
  const valid = value => object(value) && value.success === true && value.backend === 'weflow-cli-nt' && username(value.ownWxid) &&
    !targets.includes(value.ownWxid) && value.accountDirectory === binding.account.myWxid && value.readOnly === true && value.automaticReplies === false &&
    value.desktopAccountVerified === false && value.pollHealthy === true && cursorValid(value.cursor) && Array.isArray(value.allowedTalkers) && JSON.stringify(value.allowedTalkers) === JSON.stringify(targets) &&
    (selectionVersion === undefined || value.selectionVersion === selectionVersion);
  if (!valid(scope)) throw fault('READER_TARGET_SCOPE_INVALID');
  const baseUrl = `http://127.0.0.1:${packet.port}`;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
  const combined = AbortSignal.any([signal, controller.signal]);
  async function request(route, { auth = true, method = 'GET', headers = {} } = {}) {
    const response = await fetchImpl(baseUrl + route, { method, headers: { ...(auth ? { Authorization: 'Bearer ' + token } : {}), ...headers }, redirect: 'error', signal: combined });
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 2 * 1024 * 1024) throw fault('READER_TARGET_RESPONSE_LIMIT');
    let body; try { body = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw fault('READER_TARGET_PROTOCOL_INVALID'); }
    return { status: response.status, body };
  }
  try {
    const status = await request('/api/v1/reader/status');
    if (status.status !== 200 || !valid(status.body) || status.body.ownWxid !== scope.ownWxid) throw fault('READER_TARGET_SCOPE_INVALID');
    const from = Math.floor(Date.now() / 1000), prefix = `/api/v1/messages?receipt_scope=1&from_time=${from}&talker=`;
    for (const target of targets) {
    const receipt = await request(prefix + encodeURIComponent(target));
    const r = receipt.body?.scope;
    if (receipt.status !== 200 || receipt.body.success !== true || !object(r) || r.version !== 1 || r.complete !== true || r.accountWxid !== scope.ownWxid ||
        r.accountDirectory !== binding.account.myWxid || r.talker !== target || r.fromTime !== from || !Number.isInteger(r.throughTime) ||
        r.throughTime < from || r.throughTime > Math.floor(Date.now() / 1000) || !Array.isArray(receipt.body.messages) || receipt.body.messages.length > 500) throw fault('READER_TARGET_SCOPE_INVALID');
    }
    for (const [route, options, expected] of [
      ['/api/v1/reader/status', { auth: false }, 401], ['/api/v1/reader/status', { method: 'POST' }, 405],
      ['/api/v1/contacts', {}, 404], [prefix + 'filehelper', {}, 403], ['/api/v1/reader/status', { headers: { Origin: 'https://invalid.example' } }, 403],
    ]) if ((await request(route, options)).status !== expected) throw fault('READER_TARGET_HTTP_BOUNDARY_FAILED');
    const events = await fetchImpl(baseUrl + '/api/v1/push/messages', { headers: { Authorization: 'Bearer ' + token, 'Last-Event-ID': packet.initialCursor }, redirect: 'error', signal: combined });
    try { if (events.status !== 200 || !events.headers.get('content-type')?.startsWith('text/event-stream')) throw fault('READER_TARGET_HTTP_BOUNDARY_FAILED'); }
    finally { await events.body?.cancel(); }
    return scope;
  } finally { clearTimeout(timer); controller.abort(); }
}

/** Starts a receive-only sidecar. Access fields are private/non-enumerable.
 * Consumers must persist rawid and resume SSE using Last-Event-ID. A new stream
 * without a cursor begins at the current tail. There is no auto-send capability.
 */
export async function startTargetReader({ bindingFile, selectionFile, port, root = projectRoot, signal,
  check = checkLocalReader, spawnImpl = spawn, fetchImpl = fetch, startupTimeoutMs = 30000, stopTimeoutMs = 10000, bindingCheckMs = 5000 } = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 500 || startupTimeoutMs > 30000 ||
      !Number.isInteger(stopTimeoutMs) || stopTimeoutMs < 100 || stopTimeoutMs > 12000 || !Number.isInteger(bindingCheckMs) || bindingCheckMs < 50 || bindingCheckMs > 30000)
    throw fault('READER_TARGET_OPTIONS_INVALID');
  if (signal?.aborted) throw fault('READER_TARGET_CANCELLED');
  const binding = localBinding(root, check);
  let selection, validateSelection;
  function loadSelection() {
    if (typeof selectionFile !== 'string' || path.resolve(selectionFile) !== path.resolve(root, 'state/reader-service/selection.json')) throw fault('READER_TARGET_SELECTION_PATH_INVALID');
    noLinks(selectionFile); const stat = fs.statSync(selectionFile, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > 131072) throw fault('READER_TARGET_SELECTION_INVALID');
    try { return validateSelection(JSON.parse(fs.readFileSync(selectionFile, 'utf8')), binding.account.accountRef); }
    catch { throw fault('READER_TARGET_SELECTION_INVALID'); }
  }
  if (selectionFile !== undefined) {
    if (bindingFile !== undefined) throw fault('READER_TARGET_OPTIONS_INVALID');
    validateSelection = (await import('./target-selection.mjs')).validateTargetSelection;
    selection = loadSelection();
  }
  const target = selection ? null : loadTarget(bindingFile, root, binding.account.accountRef);
  const targets = selection ? selection.targets.map(item => item.wxid) : [target.targetWxid];
  const directory = noLinks(path.join(root, 'state/reader-service')), lock = noLinks(path.join(directory, 'service.lock')), lease = crypto.randomUUID();
  try { fs.writeFileSync(lock, JSON.stringify({ version: 1, pid: process.pid, lease }), { flag: 'wx', mode: 0o600 }); }
  catch { throw fault('READER_TARGET_BUSY'); }
  const controller = new AbortController(), token = crypto.randomBytes(32).toString('hex');
  let session, child, exitInfo, stopped = false, packetSeen = false, output = '', bytes = 0, failure, stopping = false, cleaned = false, readyDelivered = false, monitor, startupTimer, stopTimer;
  let resolveReady, rejectReady, resolveDone, rejectDone, scope;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  done.catch(() => {});
  ready.catch(() => {});
  const safe = error => /^READER_TARGET_[A-Z_]{1,64}$/.test(error?.code ?? '') ? error : fault('READER_TARGET_FAILED');
  const fail = error => { failure ??= safe(error); rejectReady(failure); void stop(); };
  const checkCurrent = () => {
    unchanged(root, check, binding);
    if (selection) {
      if (JSON.stringify(loadSelection()) !== JSON.stringify(selection)) throw fault('READER_TARGET_SELECTION_CHANGED');
    } else if (JSON.stringify(loadTarget(bindingFile, root, binding.account.accountRef)) !== JSON.stringify(target)) throw fault('READER_TARGET_BINDING_CHANGED');
  };
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(startupTimer); clearTimeout(stopTimer); clearInterval(monitor);
    signal?.removeEventListener('abort', abort);
    controller.abort();
    if (child && (!stopped || exitInfo?.code !== 0 || exitInfo?.signal)) {
      const error = fault('READER_TARGET_CLEANUP_UNCONFIRMED'); rejectReady(error); rejectDone(error); return;
    }
    try {
      if (session && fs.existsSync(session)) {
        // Production Python removes its private configuration before ack. Empty
        // mock sessions are also safe; never recursively remove an unknown tree.
        noLinks(session); fs.rmdirSync(session);
      }
      noLinks(lock);
      if (JSON.parse(fs.readFileSync(lock, 'utf8')).lease !== lease) throw fault('READER_TARGET_LOCK_CHANGED');
      fs.unlinkSync(lock);
    } catch { const error = fault('READER_TARGET_CLEANUP_UNCONFIRMED'); rejectReady(error); rejectDone(error); return; }
    if (!readyDelivered) rejectReady(failure ?? fault('READER_TARGET_START_FAILED'));
    if (failure) rejectDone(failure);
    else resolveDone({ ok: true, processStopped: true, automaticReplies: false, inputSent: false });
  }
  function stop() {
    if (stopping) return done;
    stopping = true;
    controller.abort(); clearInterval(monitor);
    if (!child) { cleanup(); return done; }
    if (exitInfo) { cleanup(); return done; }
    try { child.stdin.end(); } catch { /* Retain lease unless Python acknowledges. */ }
    stopTimer = setTimeout(() => {
      if (exitInfo) return;
      child.kill(); // Only this child handle; never WeChat or a guessed process tree.
      failure ??= fault('READER_TARGET_CLEANUP_UNCONFIRMED');
      cleanup();
    }, stopTimeoutMs);
    return done;
  }
  const abort = () => fail(fault('READER_TARGET_CANCELLED'));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    session = fs.mkdtempSync(path.join(directory, 'session-')); noLinks(session);
    child = childProcess(root, binding, spawnImpl);
    child.on('error', () => fail(fault('READER_TARGET_START_FAILED')));
    child.stdin.on('error', () => { if (!stopping) fail(fault('READER_TARGET_PIPE_FAILED')); });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) fail(fault('READER_TARGET_PROTOCOL_INVALID')); });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 65536) { fail(fault('READER_TARGET_PROTOCOL_INVALID')); return; }
      output += chunk.toString('utf8');
      while (output.includes('\n')) {
        const index = output.indexOf('\n'), line = output.slice(0, index); output = output.slice(index + 1);
        let packet; try { packet = JSON.parse(line); } catch { fail(fault('READER_TARGET_PROTOCOL_INVALID')); return; }
        if (!object(packet) || packet.ok !== true) { fail(fault('READER_TARGET_CHILD_FAILED')); return; }
        if (packet.type === 'stopped' && (packetSeen || ['READER_TARGET_SELECTION_CHANGED','READER_TARGET_EVENT_GAP'].includes(packet.reason)) && !stopped && packet.automaticReplies === false) {
          stopped = true;
          if (['READER_TARGET_SELECTION_CHANGED','READER_TARGET_EVENT_GAP'].includes(packet.reason)) failure ??= fault(packet.reason);
          if (!packetSeen) rejectReady(failure);
          continue;
        }
        if (packetSeen || packet.type !== 'ready' || packet.port !== port) { fail(fault('READER_TARGET_PROTOCOL_INVALID')); return; }
        packetSeen = true;
        void (async () => {
          scope = await verifyService(packet, binding, targets, selection?.version, token, fetchImpl, controller.signal);
          checkCurrent();
          if (stopping || controller.signal.aborted || exitInfo) throw fault('READER_TARGET_START_CANCELLED');
          clearTimeout(startupTimer);
          monitor = setInterval(() => { try { checkCurrent(); } catch (error) { fail(error); } }, bindingCheckMs);
          const access = { baseUrl: `http://127.0.0.1:${port}`, token, accountWxid: scope.ownWxid, accountDirectory: binding.account.myWxid,
            accountRef: binding.account.accountRef, targets: Object.freeze([...targets]), selectionVersion: selection?.version ?? null,
            ...(target ? { targetWxid: target.targetWxid, targetId: target.targetId } : {}), initialCursor: packet.initialCursor,
            signal: controller.signal, stop, done };
          const handle = { receiving: true, readOnly: true, automaticReplies: false, inputSent: false };
          for (const [key, value] of Object.entries(access)) Object.defineProperty(handle, key, { value, enumerable: false });
          readyDelivered = true; resolveReady(Object.freeze(handle));
        })().catch(fail);
      }
    });
    child.on('close', (code, exitSignal) => {
      exitInfo = { code, signal: exitSignal };
      if (!stopping) failure ??= fault('READER_TARGET_UNEXPECTED_EXIT');
      if (output.trim()) failure ??= fault('READER_TARGET_PROTOCOL_INVALID');
      if (!packetSeen) rejectReady(failure ?? fault('READER_TARGET_START_FAILED'));
      cleanup();
    });
    startupTimer = setTimeout(() => fail(fault('READER_TARGET_START_TIMEOUT')), startupTimeoutMs);
    child.stdin.write(JSON.stringify({ ...common(binding, 'serve'), ...(selection ? { selection } : { binding: target }), port, token, sessionRoot: session }) + '\n');
    if (signal?.aborted) abort();
    return await ready;
  } catch (error) {
    failure ??= safe(error);
    try { await stop(); } catch (cleanupError) { if (cleanupError.code === 'READER_TARGET_CLEANUP_UNCONFIRMED') throw cleanupError; }
    throw failure;
  }
}
