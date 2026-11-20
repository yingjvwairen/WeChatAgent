import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { UiReaderReceipts } from './ui-reader-receipts.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u0020\u007f]/u.test(value);
const decimal = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
const fault = code => Object.assign(new Error(code), { code });
const safeCode = error => /^UI_[A-Z0-9_]{1,80}$/.test(error?.code ?? '') ? error.code : 'UI_PREVIEW_OPERATION_FAILED';
const nativeCode = value => typeof value === 'string' && /^DRAFT_[A-Z_]{1,80}$/.test(value) ? value : null;
const cleanupCode = error => /^READER_LOCAL_API_[A-Z_]{1,80}$/.test(error?.code ?? '') ? error.code : 'UI_PREVIEW_READER_CLEANUP_UNCONFIRMED';
const states = new Set(['created', 'preparing', 'prepared', 'submit-intent', 'submitted', 'unknown', 'not-submitted', 'confirmed']);

export function validateSubmitPreview(options) {
  const { directory, deliveryId, accountWxid, accountDirectory, accountRef, accountScopeHash, target, text, permission } = options ?? {};
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || !digest(deliveryId) || !identifier(accountWxid) ||
      !identifier(accountDirectory) || /[\\/]/.test(accountDirectory) || ['.', '..'].includes(accountDirectory) || !identifier(accountRef) ||
      !digest(accountScopeHash) || target !== 'filehelper' || typeof text !== 'string' || !text.trim() || !text.isWellFormed() ||
      text.length > 4000 || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(text)) throw fault('UI_PREVIEW_CONFIG_INVALID');
  const textSha256 = hash(text);
  if (!object(permission) || permission.sendPreview !== true || permission.target !== 'filehelper' || permission.textSha256 !== textSha256)
    throw fault('UI_PREVIEW_TEXT_PERMISSION_REQUIRED');
  return { version: 1, deliveryId, accountScopeHash, accountRefHash: hash(accountRef), accountHash: hash(accountWxid),
    accountDirectoryHash: hash(accountDirectory), target, textSha256 };
}

function noLinks(file) {
  for (let item = path.resolve(file);;) {
    if (fs.lstatSync(item, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('UI_PREVIEW_LINK_REFUSED');
    const parent = path.dirname(item); if (parent === item) return; item = parent;
  }
}
function atomic(file, value) {
  noLinks(file); const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    const handle = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(handle, JSON.stringify(value)); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    noLinks(file); fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function readState(file, binding) {
  noLinks(file); const stat = fs.statSync(file, { throwIfNoEntry: false }); if (!stat) return null;
  if (!stat.isFile() || stat.size > 32768) throw fault('UI_PREVIEW_STATE_INVALID');
  let value; try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw fault('UI_PREVIEW_STATE_INVALID'); }
  if (!object(value) || Object.keys(binding).some(key => value[key] !== binding[key]) || !states.has(value.state) ||
      !integer(value.createdAt) || !integer(value.updatedAt) || value.updatedAt < value.createdAt ||
      value.nativeReason != null && nativeCode(value.nativeReason) !== value.nativeReason ||
      ['readerSessionStarted', 'readerSessionStopped', 'cleanupUnknown'].some(key => value[key] !== undefined && typeof value[key] !== 'boolean') ||
      value.submittedAt !== undefined && (!integer(value.submittedAt) || !integer(value.deadlineAt) || value.deadlineAt <= value.submittedAt || value.deadlineAt - value.submittedAt > 300000))
    throw fault('UI_PREVIEW_STATE_INVALID');
  return value;
}
function acquire(file) {
  noLinks(file); const owner = crypto.randomUUID();
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, owner })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return () => { noLinks(file); if (JSON.parse(fs.readFileSync(file, 'utf8')).owner === owner) fs.unlinkSync(file); };
  } catch (error) {
    // This single-attempt tool never deletes another owner's lock. Following a
    // crash, an operator may inspect the state and remove the stale lock; the
    // persisted delivery ID still permits receipt queries only, never input.
    if (error.code === 'EEXIST') throw fault('UI_PREVIEW_BUSY');
    throw error;
  }
}
function active(signal, expiresAt, now) {
  if (signal?.aborted) throw fault('UI_PREVIEW_ABORTED');
  if (!integer(expiresAt) || now() >= expiresAt) throw fault('UI_PREVIEW_SESSION_EXPIRED');
}
function receiptMatches(receipt, job, accountDirectory) {
  return object(receipt) && receipt.type === 'wechat-database-text-v1' && receipt.deliveryId === job.id && receipt.account === job.account &&
    receipt.accountDirectory === accountDirectory && receipt.target === 'filehelper' && receipt.textSha256 === hash(job.text) &&
    digest(receipt.sourceShard) && decimal(receipt.localId) && decimal(receipt.serverId) && integer(receipt.createTime) &&
    receipt.createTime >= Math.floor(job.submittedAt / 1000) && receipt.createTime <= Math.floor(job.deadlineAt / 1000) &&
    integer(receipt.observedAt) && receipt.observedAt >= job.submittedAt;
}
function validateFresh(value, options, now) {
  const { session, accountProof } = value ?? {}, evidence = accountProof?.evidence;
  if (!object(session) || session.target !== 'filehelper' || session.accountScopeHash !== options.accountScopeHash || !session.editorFocusProof || !session.sendButtonRect ||
      !object(accountProof) || accountProof.accountRef !== options.accountRef || accountProof.accountScopeHash !== options.accountScopeHash ||
      !object(evidence) || evidence.ok !== true || evidence.proof !== 'process-open-database-v1' || evidence.complete !== true ||
      evidence.processOpenedExpectedDatabase !== true || evidence.accountRootsObserved !== 1 || evidence.consistentPathScans !== 2 || evidence.snapshotAtomic !== false ||
      evidence.processId !== session.pid || evidence.processCreatedFileTimeUtc !== session.processCreatedFileTimeUtc ||
      ['ready', 'desktopAccountVerified', 'targetVerified', 'draftVerified', 'inputSent'].some(key => evidence[key] !== false) ||
      !integer(evidence.maximumEvidenceAgeMs) || evidence.maximumEvidenceAgeMs < 1 || evidence.maximumEvidenceAgeMs > 500)
    throw fault('UI_PREVIEW_ACCOUNT_PROOF_INVALID');
  const observed = Date.parse(evidence.observedAtUtc), age = now() - observed;
  if (!Number.isFinite(observed) || age < 0 || age > evidence.maximumEvidenceAgeMs) throw fault('UI_PREVIEW_ACCOUNT_PROOF_EXPIRED');
  return session;
}
function report(state, reused = false) {
  return { deliveryId: state.deliveryId, state: state.state, confirmed: state.state === 'confirmed', reused,
    textSha256: state.textSha256, reason: state.reason ?? null, nativeReason: state.nativeReason ?? null,
    readerSessionStopped: state.readerSessionStopped === true, cleanupUnknown: state.readerSessionStarted === true && state.readerSessionStopped !== true,
    cleanupReason: state.cleanupReason ?? null, ready: false, unattendedReady: false,
    ...(state.state === 'confirmed' ? { receipt: structuredClone(state.receipt) } : {}) };
}

/** A single operator-calibrated filehelper attempt. Importing does not operate
 * WeChat. A persisted ID is never submitted again, including after a crash.
 * The account proof is process/database corroboration, not desktop identity.
 */
export async function runSubmitPreview(options, dependencies = {}) {
  const binding = validateSubmitPreview(options), now = dependencies.now ?? Date.now;
  if (typeof options.freshSession !== 'function' || typeof now !== 'function') throw fault('UI_PREVIEW_CONFIG_INVALID');
  options = { ...options, permission: { ...options.permission } };
  const directory = path.resolve(options.directory); noLinks(directory); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, binding.deliveryId + '.json'), unlock = acquire(file + '.lock');
  let state, reused;
  const write = patch => { state = { ...state, ...patch, updatedAt: now() }; atomic(file, state); return state; };
  try {
    state = readState(file, binding); reused = state !== null;
    if (!state) { state = { ...binding, state: 'created', createdAt: now(), updatedAt: now() }; atomic(file, state); }
    const job = () => ({ id: binding.deliveryId, account: options.accountWxid, target: 'filehelper', text: options.text, submittedAt: state.submittedAt, deadlineAt: state.deadlineAt });
    if (state.state === 'confirmed') {
      if (!receiptMatches(state.receipt, job(), options.accountDirectory)) throw fault('UI_PREVIEW_STATE_INVALID');
      return report(state, true);
    }
    if (state.state === 'not-submitted' || reused && state.submittedAt === undefined) return report(state, true);
    const withApi = dependencies.withLocalReceiptApi ?? (await import('./reader-local-api.mjs')).withLocalReceiptApi;
    const receiptsFactory = dependencies.receiptsFactory ?? (config => new UiReaderReceipts(config));
    const submit = dependencies.submitDraftPreview ?? (async request => (await import('./draft-probe.mjs')).submitDraftPreview(request));
    const wait = dependencies.wait ?? ((ms, signal) => new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); resolve(); };
      const aborted = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); reject(fault('UI_PREVIEW_ABORTED')); };
      const timer = setTimeout(done, ms); signal?.addEventListener('abort', aborted, { once: true }); if (signal?.aborted) aborted();
    }));
    let callbackLive = true;
    try {
      write({ readerSessionStarted: true, readerSessionStopped: false, cleanupUnknown: true, cleanupReason: null });
      const apiResult = await withApi({ expectedAccountRef: options.accountRef, timeoutMs: 30000, signal: options.signal, callback: async context => {
        const signal = options.signal ? AbortSignal.any([options.signal, context.signal]) : context.signal;
        const assertActive = () => { if (!callbackLive) throw fault('UI_PREVIEW_CALLBACK_CLOSED'); active(signal, context.expiresAt, now); };
        assertActive();
        if (context.accountRef !== options.accountRef || context.accountWxid !== options.accountWxid || context.accountDirectory !== options.accountDirectory)
          throw fault('UI_PREVIEW_READER_ACCOUNT_MISMATCH');
        const receipts = receiptsFactory({ directory: path.join(directory, 'receipts'), baseUrl: context.baseUrl, token: context.token,
          accountWxid: options.accountWxid, accountDirectory: options.accountDirectory, now });
        const checked = await receipts.checkBinding({ signal }); assertActive();
        if (checked?.verified !== true || checked.account !== options.accountWxid || checked.accountDirectory !== options.accountDirectory)
          throw fault('UI_PREVIEW_READER_ACCOUNT_MISMATCH');
        if (!reused) {
          if (context.expiresAt - now() < 8000) throw fault('UI_PREVIEW_SESSION_EXPIRED');
          write({ state: 'preparing', submittedAt: now(), deadlineAt: Math.min(now() + 22000, context.expiresAt - 250) });
          const prepared = await receipts.prepare(job(), { signal });
          assertActive();
          if (prepared?.submissionAllowed !== true || typeof prepared.preparationToken !== 'string') throw fault('UI_PREVIEW_PREPARATION_REFUSED');
          write({ state: 'prepared', preparationToken: prepared.preparationToken });
          let nativeCalled = false;
          try {
            assertActive();
            const fresh = await options.freshSession({ accountRef: options.accountRef, accountScopeHash: options.accountScopeHash, signal });
            const session = validateFresh(fresh, options, now);
            assertActive();
            if (context.expiresAt - now() < 5000 || state.deadlineAt - now() < 5000) throw fault('UI_PREVIEW_SESSION_EXPIRED');
            // Persist before any native operation; crash recovery can only query.
            write({ state: 'submit-intent', reason: null });
            validateFresh(fresh, options, now); assertActive();
            nativeCalled = true;
            let native;
            try { native = await submit({ session, expectedDraft: options.text, idleMs: options.idleMs ?? 1000, signal,
              permission: { selectionCopy: true, caretToEnd: true, clipboardRestore: true, submitPreview: true } }); }
            catch (error) { native = { sendInputAttempted: error?.sendInputAttempted, submitAttempted: error?.submitAttempted, reason: nativeCode(error?.code) }; }
            assertActive();
            const nativeReason = nativeCode(native?.reason);
            const refused = native?.sendInputAttempted === false && native?.submitAttempted === false;
            if (refused) {
              const marked = await receipts.markNotSubmitted(job(), { preparationToken: prepared.preparationToken,
                nativeResult: { performed: false, attempted: false, reason: 'UI_PREVIEW_NATIVE_REFUSED' } });
              assertActive();
              if (marked?.notSubmitted !== true) throw fault('UI_PREVIEW_REFUSAL_UNCONFIRMED');
              write({ state: 'not-submitted', reason: 'UI_PREVIEW_NATIVE_REFUSED', nativeReason }); return;
            }
            write({ state: native?.submitInputApplied === true && native?.sendInputAttempted === true ? 'submitted' : 'unknown', reason: null, nativeReason });
          } catch (error) {
            if (!nativeCalled && callbackLive) {
              const marked = await receipts.markNotSubmitted(job(), { preparationToken: prepared.preparationToken,
                nativeResult: { performed: false, attempted: false, reason: safeCode(error) } });
              if (!callbackLive) throw fault('UI_PREVIEW_CALLBACK_CLOSED');
              if (marked?.notSubmitted === true) write({ state: 'not-submitted', reason: safeCode(error) });
              else write({ state: 'unknown', reason: 'UI_PREVIEW_REFUSAL_UNCONFIRMED' });
            }
            throw error;
          }
        }
        // Existing attempts only query, never prepare or invoke the native sender.
        for (let count = 0; count < 24; count++) {
          assertActive();
          const result = await receipts.query(job(), { signal });
          assertActive();
          if (result?.confirmed === true) {
            if (!receiptMatches(result.receipt, job(), options.accountDirectory)) throw fault('UI_PREVIEW_RECEIPT_MISMATCH');
            write({ state: 'confirmed', receipt: structuredClone(result.receipt), reason: null }); return;
          }
          if (now() >= state.deadlineAt || context.expiresAt - now() < 750) break;
          await wait(500, signal);
        }
        write({ state: 'unknown', reason: 'UI_PREVIEW_RECEIPT_UNCONFIRMED' });
      } });
      if (apiResult?.processStopped !== true) throw fault('UI_PREVIEW_READER_CLEANUP_UNCONFIRMED');
      write({ readerSessionStopped: true, cleanupUnknown: false, cleanupReason: null });
    } catch (error) {
      write({ readerSessionStopped: false, cleanupUnknown: true, cleanupReason: cleanupCode(error),
        ...(state.state !== 'confirmed' && state.state !== 'not-submitted' ? { state: 'unknown', reason: safeCode(error) } : {}) });
    } finally { callbackLive = false; }
    return report(state, reused);
  } finally { unlock(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--check') console.log(JSON.stringify({ module: 'ui-submit-preview', developmentOnly: true, target: 'filehelper', ready: false, inputSent: false, cliSendSupported: false }));
  else { console.error('UI_PREVIEW_CLI_SEND_UNSUPPORTED'); process.exitCode = 1; }
}
