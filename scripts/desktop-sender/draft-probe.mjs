import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const fault = (code, evidence = {}) => Object.assign(new Error(code), { code, ...evidence });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hex = (value, length) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const decimal = value =>
  typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 0x7fffffffffffffffn;
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const executablePath = value =>
  typeof value === 'string' &&
  /^[a-z]:[\\/]/i.test(value) &&
  !/[\0\r\n]/.test(value) &&
  /(?:^|[\\/])(?:Weixin|WeChat)\.exe$/i.test(value);
const rect = value =>
  object(value) &&
  ['left', 'top', 'right', 'bottom'].every(key => integer(value[key], -32768, 32768)) &&
  value.right > value.left &&
  value.bottom > value.top &&
  value.right - value.left <= 8192 &&
  value.bottom - value.top <= 8192;
const inside = (outer, inner) =>
  inner.left >= outer.left && inner.top >= outer.top && inner.right <= outer.right && inner.bottom <= outer.bottom;
const overlap = (left, right) =>
  left.left < right.right && right.left < left.right && left.top < right.bottom && right.top < left.bottom;
const submitUnknown = {
  submitAttempted: null,
  sendInputAttempted: null,
  submitInputApplied: null,
  deliveryConfirmed: false,
};
const submitNotAttempted = {
  submitAttempted: false,
  sendInputAttempted: false,
  submitInputApplied: false,
  deliveryConfirmed: false,
};

// Diagnostic names stay on the private return/error object; never print payload data.
function copyFormatDiagnostic(value) {
  if (
    !object(value) ||
    !Array.isArray(value.entries) ||
    value.entries.length > 16 ||
    !integer(value.total, 0, 65536) ||
    typeof value.truncated !== 'boolean' ||
    value.payloadIncluded !== false
  )
    return null;
  const entries = [];
  for (const entry of value.entries) {
    if (
      !object(entry) ||
      !integer(entry.id, 1, 65535) ||
      (entry.registeredName !== null &&
        (entry.id < 0xc000 || typeof entry.registeredName !== 'string' || entry.registeredName.length > 128))
    )
      return null;
    entries.push({ id: entry.id, registeredName: entry.registeredName });
  }
  return { entries, total: value.total, truncated: value.truncated, payloadIncluded: false };
}

/** An assertion from the caller's private calibration session, not an account/target verifier. */
export function validateDraftRequest({ session, expectedDraft, permission, idleMs = 1000 }, now = Date.now()) {
  if (!object(permission) || ['selectionCopy', 'caretToEnd', 'clipboardRestore'].some(key => permission[key] !== true))
    throw fault('DRAFT_ACTION_PERMISSION_REQUIRED');
  if (
    !object(session) ||
    session.version !== 1 ||
    session.target !== 'filehelper' ||
    !hex(session.id, 32) ||
    !hex(session.calibrationHash, 64) ||
    !hex(session.accountScopeHash, 64) ||
    !executablePath(session.executable) ||
    !decimal(session.hwnd) ||
    !decimal(session.focusHwnd) ||
    !decimal(session.processCreatedFileTimeUtc) ||
    !integer(session.pid, 1, 0xffffffff) ||
    !integer(session.dpi, 48, 768) ||
    !integer(session.lastInputTick, 0, 0xffffffff) ||
    !integer(idleMs, 0, 300000) ||
    !rect(session.clientRect) ||
    !rect(session.captureRect) ||
    !rect(session.editorRect) ||
    session.clientRect.left !== 0 ||
    session.clientRect.top !== 0 ||
    !inside(session.clientRect, session.editorRect) ||
    session.clientRect.right !== session.captureRect.right - session.captureRect.left ||
    session.clientRect.bottom !== session.captureRect.bottom - session.captureRect.top
  )
    throw fault('DRAFT_SESSION_INVALID');
  if (
    !integer(session.issuedAtMs, now - 30000, now) ||
    !integer(session.expiresAtMs, now + 1, session.issuedAtMs + 30000)
  )
    throw fault('DRAFT_SESSION_EXPIRED');
  if (session.editorFocusProof !== undefined) {
    const proof = session.editorFocusProof;
    if (
      !object(proof) ||
      Object.keys(proof).length !== 3 ||
      proof.kind !== 'operator-calibrated-edit-region' ||
      proof.calibrationHash !== session.calibrationHash ||
      proof.lastInputTick !== session.lastInputTick
    )
      throw fault('DRAFT_EDITOR_PROOF_INVALID');
    if (typeof expectedDraft !== 'string' || !expectedDraft.length) throw fault('DRAFT_EXPECTED_TEXT_REQUIRED');
  }
  if (
    expectedDraft !== undefined &&
    (typeof expectedDraft !== 'string' ||
      !expectedDraft.length ||
      expectedDraft.length > 16000 ||
      expectedDraft.includes('\0'))
  )
    throw fault('DRAFT_EXPECTED_TEXT_INVALID');
  // Copy only documented fields into the private wire request.
  const fields = [
    'version',
    'id',
    'calibrationHash',
    'accountScopeHash',
    'target',
    'executable',
    'hwnd',
    'focusHwnd',
    'processCreatedFileTimeUtc',
    'pid',
    'dpi',
    'lastInputTick',
    'issuedAtMs',
    'expiresAtMs',
    'clientRect',
    'captureRect',
    'editorRect',
    'editorFocusProof',
  ];
  return {
    action: 'verifyDraft',
    permission: { selectionCopy: true, caretToEnd: true, clipboardRestore: true },
    idleMs,
    ...(expectedDraft === undefined ? {} : { expectedDraft }),
    session: Object.fromEntries(fields.filter(key => session[key] !== undefined).map(key => [key, session[key]])),
  };
}

export function validateAppendRequest(options, now = Date.now()) {
  if (options.permission?.submitPreview === true) throw fault('DRAFT_ACTION_COMBINATION_FORBIDDEN');
  const request = validateDraftRequest(options, now);
  if (options.permission?.appendPreview !== true || !request.session.editorFocusProof)
    throw fault('DRAFT_APPEND_PERMISSION_REQUIRED');
  const { appendText, intervalMs = 300 } = options;
  if (typeof appendText !== 'string' || !appendText.length || appendText.length > 1024)
    throw fault('DRAFT_APPEND_TEXT_INVALID');
  for (const character of appendText) {
    const scalar = character.codePointAt(0);
    if (scalar >= 0xd800 && scalar <= 0xdfff) throw fault('DRAFT_APPEND_TEXT_INVALID');
    if (/[\p{Cc}\u2028\u2029]/u.test(character) || (/\p{Cf}/u.test(character) && character !== '\u200d'))
      throw fault('DRAFT_APPEND_CONTROL_FORBIDDEN');
  }
  const appendGraphemes = [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(appendText)].map(
    part => part.segment,
  );
  if (
    appendGraphemes.length < 1 ||
    appendGraphemes.length > 16 ||
    appendGraphemes.some(part => part.length > 64) ||
    request.expectedDraft.length + appendText.length > 16000
  )
    throw fault('DRAFT_APPEND_LIMIT_INVALID');
  const budget = request.idleMs + (appendGraphemes.length - 1) * intervalMs + 2000;
  if (!integer(intervalMs, 120, 500) || budget > 8000 || request.session.expiresAtMs - now < budget)
    throw fault('DRAFT_APPEND_BUDGET_EXCEEDED');
  return {
    ...request,
    action: 'appendPreview',
    permission: { ...request.permission, appendPreview: true },
    appendGraphemes,
    intervalMs,
  };
}

export function validateSubmitRequest(options, now = Date.now()) {
  const request = validateDraftRequest(options, now);
  if (options.permission?.submitPreview !== true || !request.session.editorFocusProof)
    throw fault('DRAFT_SUBMIT_PERMISSION_REQUIRED');
  if (
    options.permission?.appendPreview === true ||
    options.appendText !== undefined ||
    options.appendGraphemes !== undefined
  )
    throw fault('DRAFT_ACTION_COMBINATION_FORBIDDEN');
  const button = options.session.sendButtonRect;
  if (
    !rect(button) ||
    !inside(request.session.clientRect, button) ||
    overlap(request.session.editorRect, button) ||
    button.right - button.left < 4 ||
    button.bottom - button.top < 4
  )
    throw fault('DRAFT_SEND_BUTTON_INVALID');
  const budget = request.idleMs + 2000;
  if (budget > 8000 || request.session.expiresAtMs - now < budget) throw fault('DRAFT_SUBMIT_BUDGET_EXCEEDED');
  return {
    ...request,
    action: 'submitPreview',
    permission: { ...request.permission, submitPreview: true },
    session: { ...request.session, sendButtonRect: { ...button } },
  };
}

function probeExecutable(root) {
  const executable = path.join(root, 'state/ui-host/WechatQtActions.exe');
  for (let item = path.resolve(executable); ; item = path.dirname(item)) {
    const info = fs.lstatSync(item, { throwIfNoEntry: false });
    if (info?.isSymbolicLink()) throw fault('DRAFT_COMPONENT_LINK_REJECTED');
    if (path.dirname(item) === item) break;
  }
  if (!fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) throw fault('DRAFT_COMPONENT_MISSING');
  return executable;
}

async function invoke({ root, args, request, spawnImpl, timeoutMs, signal }) {
  if (signal?.aborted) throw fault('DRAFT_CANCELLED_BEFORE_START', submitNotAttempted);
  const executable = probeExecutable(root);
  return new Promise((resolve, reject) => {
    let child,
      output = '',
      outputBytes = 0,
      stderrBytes = 0,
      failure,
      finished = false,
      reap;
    const decoder = new StringDecoder('utf8');
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(reap);
      signal?.removeEventListener('abort', onAbort);
      error ? reject(error) : resolve(result);
    };
    const abort = code => {
      if (failure || finished) return;
      failure = fault(code, { inputAttempted: null, clipboardRestored: null, ...submitUnknown });
      child?.kill();
      reap = setTimeout(
        () =>
          finish(
            fault('DRAFT_PROCESS_EXIT_UNCONFIRMED', {
              inputAttempted: null,
              clipboardRestored: null,
              ...submitUnknown,
            }),
          ),
        1000,
      );
    };
    const onAbort = () => abort('DRAFT_OPERATION_CANCELLED');
    const timer = setTimeout(() => abort('DRAFT_PROBE_TIMEOUT'), timeoutMs);
    try {
      child = spawnImpl(executable, ['--draft-probe', ...args], {
        cwd: root,
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      child.on('error', () => abort('DRAFT_COMPONENT_START_FAILED'));
      child.stdin.on('error', () => abort('DRAFT_PRIVATE_PIPE_FAILED'));
      child.stdout.on('data', value => {
        outputBytes += value.length;
        if (outputBytes > 131072) return abort('DRAFT_PROTOCOL_INVALID');
        output += decoder.write(value);
      });
      child.stderr.on('data', value => {
        stderrBytes += value.length;
        if (stderrBytes > 65536) abort('DRAFT_PROTOCOL_INVALID');
      });
      child.on('close', code => {
        if (failure) return finish(failure);
        output += decoder.end();
        let result;
        try {
          result = JSON.parse(output);
        } catch {
          return finish(fault('DRAFT_PROTOCOL_INVALID'));
        }
        if (!object(result) || result.ok !== true || code !== 0) {
          const reason =
            typeof result?.reason === 'string' && /^DRAFT_[A-Z_]{3,80}$/.test(result.reason)
              ? result.reason
              : 'DRAFT_PROBE_FAILED';
          const reportedAttempt =
            result?.submitAttempted === result?.sendInputAttempted &&
            typeof result?.submitAttempted === 'boolean' &&
            result?.ok === false &&
            code === 1
              ? result.submitAttempted
              : null;
          return finish(
            fault(reason, {
              inputAttempted: typeof result?.inputAttempted === 'boolean' ? result.inputAttempted : null,
              clipboardRestored: typeof result?.clipboardRestored === 'boolean' ? result.clipboardRestored : null,
              textInputAttempted: typeof result?.textInputAttempted === 'boolean' ? result.textInputAttempted : null,
              textVerified: false,
              graphemesApplied: integer(result?.graphemesApplied, 0, 16) ? result.graphemesApplied : null,
              graphemesVerified: 0,
              unattendedReady: false,
              submitAttempted: reportedAttempt,
              sendInputAttempted: reportedAttempt,
              submitInputApplied: reportedAttempt === false ? false : result?.submitInputApplied === true ? true : null,
              deliveryConfirmed: false,
              caretToEndInputApplied: result?.caretToEndInputApplied === true,
              copyFormats: copyFormatDiagnostic(result?.copyFormats),
            }),
          );
        }
        finish(null, result);
      });
      child.stdin.end(request === undefined ? '' : JSON.stringify(request) + '\n');
    } catch {
      abort('DRAFT_COMPONENT_START_FAILED');
    }
  });
}

export async function inspectDraftBinding({ executable, hwnd, root = projectRoot, spawnImpl = spawn } = {}) {
  if (!executablePath(executable) || !decimal(hwnd)) throw fault('DRAFT_INSPECT_ARGUMENTS_INVALID');
  const result = await invoke({
    root,
    args: ['--inspect', '--executable', executable, '--hwnd', hwnd],
    spawnImpl,
    timeoutMs: 11000,
  });
  if (
    result.mode !== 'inspect' ||
    result.inputSent !== false ||
    result.clipboardAccessed !== false ||
    !object(result.binding) ||
    result.binding.hwnd !== hwnd ||
    result.binding.foreground !== true ||
    !rect(result.binding.clientRect) ||
    !rect(result.binding.captureRect) ||
    !integer(result.binding.pid, 1, 0xffffffff) ||
    !decimal(result.binding.processCreatedFileTimeUtc) ||
    !integer(result.binding.lastInputTick, 0, 0xffffffff)
  )
    throw fault('DRAFT_PROTOCOL_INVALID');
  return result.binding;
}

/** Returns exact draft privately to the caller; this function deliberately never logs it. */
export async function verifyDraft({ root = projectRoot, spawnImpl = spawn, ...options } = {}) {
  const request = validateDraftRequest(options);
  const result = await invoke({ root, args: ['--verify-draft'], request, spawnImpl, timeoutMs: 11000 });
  validateResult(result, request, 'verifyDraft', request.expectedDraft);
  if (
    result.textInputAttempted !== false ||
    result.textVerified !== false ||
    result.graphemesApplied !== 0 ||
    result.graphemesVerified !== 0
  )
    throw fault('DRAFT_PROTOCOL_INVALID');
  return result;
}

function validateResult(result, request, mode, expected) {
  if (
    result.mode !== mode ||
    result.sessionId !== request.session.id ||
    result.calibrationHash !== request.session.calibrationHash ||
    result.draftVerified !== true ||
    typeof result.draft !== 'string' ||
    !result.draft.length ||
    result.draft.length > 16000 ||
    result.draft.includes('\0') ||
    (expected !== undefined && result.draft !== expected) ||
    result.copyOwnerPid !== request.session.pid ||
    !integer(result.copySequence, 0, 0xffffffff) ||
    result.plainTextOnly !== !request.session.editorFocusProof ||
    result.textProjectionOnly !== !!request.session.editorFocusProof ||
    result.richContentVerified !== false ||
    result.clipboardRestored !== true ||
    result.caretAtEndVerified !== false ||
    result.caretToEndInputApplied !== true ||
    result.messageSent !== (mode === 'submitDraftPreview' ? null : false) ||
    result.accountVerified !== false ||
    result.targetVerified !== false ||
    result.unattendedReady !== false ||
    result.editorFocusEvidence !==
      (request.session.editorFocusProof ? 'operator-calibrated-edit-region' : 'native-caret-in-editor-region') ||
    result.nativeCaretVerified !== !request.session.editorFocusProof ||
    result.expectedDraftMatched !== (request.expectedDraft !== undefined)
  )
    throw fault('DRAFT_PROTOCOL_INVALID');
}

/** Development-only append; no CLI action, automatic retry, Enter, paste, or send path. */
export async function appendDraftPreview({ root = projectRoot, spawnImpl = spawn, ...options } = {}) {
  const request = validateAppendRequest(options);
  const result = await invoke({ root, args: ['--append-preview'], request, spawnImpl, timeoutMs: 11000 });
  validateResult(result, request, 'appendDraftPreview', request.expectedDraft + request.appendGraphemes.join(''));
  if (
    result.textInputAttempted !== true ||
    result.textVerified !== true ||
    result.graphemesApplied !== request.appendGraphemes.length ||
    result.graphemesVerified !== request.appendGraphemes.length
  )
    throw fault('DRAFT_PROTOCOL_INVALID');
  return result;
}

/** One controlled click only. External receipt evidence is required for delivery. */
export async function submitDraftPreview({ root = projectRoot, spawnImpl = spawn, signal, ...options } = {}) {
  let request;
  try {
    request = validateSubmitRequest(options);
    probeExecutable(root);
    if (signal?.aborted) throw fault('DRAFT_CANCELLED_BEFORE_START');
  } catch (error) {
    throw fault(/^DRAFT_[A-Z_]+$/.test(error?.code) ? error.code : 'DRAFT_REQUEST_INVALID', submitNotAttempted);
  }
  try {
    const result = await invoke({ root, args: ['--private-action'], request, spawnImpl, timeoutMs: 11000, signal });
    validateResult(result, request, 'submitDraftPreview', request.expectedDraft);
    if (
      result.submitAttempted !== true ||
      result.sendInputAttempted !== true ||
      result.submitInputApplied !== true ||
      result.deliveryConfirmed !== false ||
      result.textInputAttempted !== false ||
      result.graphemesApplied !== 0 ||
      result.textVerified !== false
    )
      throw fault('DRAFT_PROTOCOL_INVALID');
    return result;
  } catch (error) {
    if (typeof error?.sendInputAttempted === 'boolean' || error?.sendInputAttempted === null) throw error;
    throw fault(/^DRAFT_[A-Z_]+$/.test(error?.code) ? error.code : 'DRAFT_SUBMIT_FAILED', submitUnknown);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  (async () => {
    if (args.length !== 5 || args[0] !== '--inspect' || args[1] !== '--executable' || args[3] !== '--hwnd')
      throw fault('DRAFT_INSPECT_ARGUMENTS_INVALID');
    console.log(
      JSON.stringify({ ok: true, binding: await inspectDraftBinding({ executable: args[2], hwnd: args[4] }) }, null, 2),
    );
  })().catch(error => {
    console.error(/^DRAFT_[A-Z_]+$/.test(error?.code) ? error.code : 'DRAFT_PROBE_FAILED');
    process.exitCode = 1;
  });
}
