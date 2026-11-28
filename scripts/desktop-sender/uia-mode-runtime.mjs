import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { QtActionsClient, validateQtConfig } from './qt-visual-driver.mjs';
import { inspectedQtLayoutIdentity, resolveQtPopupIdentities, toUiaLayoutConfig } from './qt-layout-profiles.mjs';
const createUiaOffscreenManager = () => {
  throw new Error('DESKTOP_OFFSCREEN_PROVIDER_REQUIRED');
};

const execute = promisify(execFile),
  fault = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = isDeepStrictEqual;
const requiredRoles = ['search', 'editor', 'header', 'send', 'recordStart', 'toolbar'];
const voiceToolbar = config =>
  config.voice?.recordingUi?.uia ? config.voice?.toolbarRect : config.voice?.recordingUi?.adaptive?.toolbarRect;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function noLinks(file) {
  for (let at = path.resolve(file); ; at = path.dirname(at)) {
    if (fs.lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('UIA_MODE_LINK_REJECTED');
    if (at === path.dirname(at)) return;
  }
}
function readConfig(file) {
  noLinks(file);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 131072) throw fault('UIA_MODE_CONFIG_INVALID');
  return validateQtConfig(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
}
const decimalId = value =>
  typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
function bound(binding) {
  return (
    object(binding) &&
    decimalId(binding.hwnd) &&
    Number.isInteger(binding.pid) &&
    binding.pid > 0 &&
    binding.pid <= 2147483647 &&
    decimalId(binding.processCreatedFileTimeUtc)
  );
}
function sameProcess(a, b) {
  return bound(a) && bound(b) && ['hwnd', 'pid', 'processCreatedFileTimeUtc'].every(key => a[key] === b[key]);
}
function rectangle(area, client) {
  return (
    object(area) &&
    Object.keys(area).length === 4 &&
    ['left', 'top', 'right', 'bottom'].every(key => Number.isSafeInteger(area[key])) &&
    area.left >= 0 &&
    area.top >= 0 &&
    area.right > area.left &&
    area.bottom > area.top &&
    area.right <= client.right &&
    area.bottom <= client.bottom
  );
}
function geometry(binding) {
  const client = binding?.clientRect,
    capture = binding?.captureRect;
  return (
    bound(binding) &&
    object(client) &&
    client.left === 0 &&
    client.top === 0 &&
    rectangle(client, client) &&
    client.right >= 600 &&
    client.bottom >= 400 &&
    client.right <= 4096 &&
    client.bottom <= 4096 &&
    Number.isInteger(binding.dpi) &&
    binding.dpi >= 48 &&
    binding.dpi <= 768 &&
    object(capture) &&
    Object.keys(capture).length === 4 &&
    Object.values(capture).every(value => Number.isSafeInteger(value) && Math.abs(value) <= 65536) &&
    capture.right - capture.left === client.right &&
    capture.bottom - capture.top === client.bottom
  );
}
function active(signal) {
  if (signal?.aborted) throw fault('UIA_MODE_ABORTED');
}
function sameGeometry(a, b) {
  return sameProcess(a, b) && a.dpi === b.dpi && same(a.clientRect, b.clientRect) && same(a.captureRect, b.captureRect);
}
function controlRect(result, role) {
  return role === 'recordStart'
    ? result.voice.recordStartRect
    : role === 'toolbar'
      ? result.voice.toolbarRect
      : result.layout[role];
}
function conversationFingerprint(value, result) {
  if (value === undefined || value === null) return undefined;
  if (
    !object(value) ||
    Object.keys(value).length !== 7 ||
    value.version !== 1 ||
    value.scope !== 'chat-title-text-v1' ||
    value.targetVerified !== false ||
    !digest(value.sha256) ||
    !digest(value.headerRuntimeIdSha256) ||
    !digest(value.titleRuntimeIdSha256) ||
    !Number.isInteger(value.textNodeCount) ||
    value.textNodeCount < 1 ||
    value.textNodeCount > 4 ||
    value.headerRuntimeIdSha256 !== result.controls?.header?.runtimeIdSha256 ||
    result.titleTextRead !== true ||
    result.fingerprintUnavailable !== false
  )
    throw fault('UIA_MODE_VERIFICATION_INVALID');
  return structuredClone(value);
}
const readinessReasons = new Set(
  [
    'WINDOW_INACTIVE',
    'SEARCH_OPEN',
    'PAGE_UNAVAILABLE',
    'EDITOR_UNAVAILABLE',
    'TITLE_UNAVAILABLE',
    'TITLE_MISMATCH',
    'CHANGED',
  ].map(value => 'UI_CONTROLS_CONVERSATION_' + value),
);
function checkedReadinessRequest(value) {
  if (
    !object(value) ||
    Object.keys(value).length !== 4 ||
    value.version !== 1 ||
    !digest(value.expectedTitleSha256) ||
    !digest(value.expectedQuerySha256) ||
    !(value.searchPopupHwnd === '0' || decimalId(value.searchPopupHwnd))
  )
    throw fault('UIA_MODE_READINESS_INVALID');
  return structuredClone(value);
}
function checkedReadiness(value, request, fingerprint) {
  if (
    !object(value) ||
    Object.keys(value).length !== 11 ||
    value.version !== 1 ||
    typeof value.ready !== 'boolean' ||
    value.targetVerified !== false ||
    value.querySha256 !== request.expectedQuerySha256 ||
    value.searchPopupHwnd !== request.searchPopupHwnd ||
    !['samePage', 'editorWritable', 'searchClosed'].every(key => typeof value[key] === 'boolean') ||
    ![value.primaryTitleSha256, value.pageRuntimeIdSha256].every(item => item === null || digest(item)) ||
    (value.ready
      ? value.reason !== null ||
        value.primaryTitleSha256 !== request.expectedTitleSha256 ||
        !digest(value.pageRuntimeIdSha256) ||
        !value.samePage ||
        !value.editorWritable ||
        !value.searchClosed ||
        !fingerprint
      : !readinessReasons.has(value.reason))
  )
    throw fault('UIA_MODE_READINESS_INVALID');
  return structuredClone(value);
}
function verificationProof(result) {
  if (result.verification === undefined) return null; // Older read-only helper: retain full verification.
  const value = result.verification;
  if (
    !object(value) ||
    value.version !== 1 ||
    !digest(value.rootRuntimeIdSha256) ||
    value.rootRuntimeIdSha256 !== result.binding.rootRuntimeIdSha256 ||
    value.dpi !== result.binding.dpi ||
    !same(value.clientRect, result.binding.clientRect) ||
    !same(value.captureRect, result.binding.captureRect) ||
    !object(value.roles) ||
    Object.keys(value.roles).length !== requiredRoles.length
  )
    throw fault('UIA_MODE_VERIFICATION_INVALID');
  const ids = new Set();
  for (const role of requiredRoles) {
    const control = value.roles[role];
    if (
      !object(control) ||
      !digest(control.runtimeIdSha256) ||
      ids.has(control.runtimeIdSha256) ||
      !Array.isArray(control.path) ||
      control.path.length < 1 ||
      control.path.length > 96 ||
      control.path.some(index => !Number.isInteger(index) || index < 0 || index >= 512) ||
      typeof control.className !== 'string' ||
      typeof control.controlType !== 'string' ||
      !same(control.rect, controlRect(result, role)) ||
      !same(control, result.controls?.[role])
    )
      throw fault('UIA_MODE_VERIFICATION_INVALID');
    ids.add(control.runtimeIdSha256);
  }
  return structuredClone(value);
}

/** A read-only JSONL worker. It owns no input/focus/clipboard state, so aborts
 * may terminate it; the caller still waits for its process-exit confirmation. */
export class UiaVerifierClient {
  constructor({ root, spawnImpl = spawn, startTimeoutMs = 5000, requestTimeoutMs = 2500, closeTimeoutMs = 1000 } = {}) {
    if (
      typeof root !== 'string' ||
      !path.isAbsolute(root) ||
      typeof spawnImpl !== 'function' ||
      ![startTimeoutMs, requestTimeoutMs, closeTimeoutMs].every(
        value => Number.isInteger(value) && value >= 10 && value <= 15000,
      )
    )
      throw fault('UIA_MODE_VERIFIER_CONFIG_INVALID');
    Object.assign(this, { root: path.resolve(root), spawnImpl, startTimeoutMs, requestTimeoutMs, closeTimeoutMs });
    this.sequence = 0;
    this.buffer = '';
    this.closing = false;
  }
  fail(code) {
    this.failure ??= fault(code);
    this.rejectReady?.(this.failure);
    this.pending?.reject(this.failure);
    this.pending = null;
    if (this.child && !this.exitResult)
      try {
        this.child.kill();
      } catch {}
  }
  line(line) {
    let packet;
    try {
      packet = JSON.parse(line);
    } catch {
      this.fail('UIA_MODE_VERIFIER_PROTOCOL_INVALID');
      return;
    }
    if (!this.ready) {
      if (
        !object(packet) ||
        packet.version !== 1 ||
        packet.ready !== true ||
        packet.backend !== 'uia-verifier' ||
        packet.readOnly !== true ||
        packet.inputSent !== false
      ) {
        this.fail('UIA_MODE_VERIFIER_PROTOCOL_INVALID');
        return;
      }
      this.ready = true;
      this.resolveReady();
      return;
    }
    const pending = this.pending;
    if (
      !pending ||
      !object(packet) ||
      Object.keys(packet).length !== 3 ||
      packet.version !== 1 ||
      packet.id !== pending.id ||
      !object(packet.report)
    ) {
      this.fail('UIA_MODE_VERIFIER_PROTOCOL_INVALID');
      return;
    }
    this.pending = null;
    pending.resolve(packet.report);
  }
  async bounded(promise, signal, timeoutMs) {
    if (signal?.aborted) {
      this.fail('UIA_MODE_ABORTED');
      throw this.failure;
    }
    const abort = () => this.fail('UIA_MODE_ABORTED'),
      timer = setTimeout(() => this.fail('UIA_MODE_VERIFIER_TIMEOUT'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await promise;
      active(signal);
      if (this.failure) throw this.failure;
      return result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  async start({ signal } = {}) {
    if (this.closing) throw fault('UIA_MODE_VERIFIER_CLOSED');
    if (this.failure) throw this.failure;
    active(signal);
    if (!this.child) {
      const executable = path.join(this.root, 'state/ui-host/WechatBackgroundControls.exe');
      noLinks(executable);
      this.readyPromise = new Promise((resolve, reject) => {
        this.resolveReady = resolve;
        this.rejectReady = reject;
      });
      this.readyPromise.catch(() => {});
      this.exitPromise = new Promise(resolve => {
        this.resolveExit = resolve;
      });
      try {
        this.child = this.spawnImpl(executable, ['--serve-layout'], {
          cwd: this.root,
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        this.exitResult = { code: null, signal: null };
        this.resolveExit(this.exitResult);
        this.fail('UIA_MODE_VERIFIER_START_FAILED');
        throw this.failure;
      }
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', chunk => {
        if (this.failure) return;
        this.buffer += chunk;
        if (Buffer.byteLength(this.buffer) > 2 * 1024 * 1024) {
          this.fail('UIA_MODE_VERIFIER_PROTOCOL_INVALID');
          return;
        }
        for (;;) {
          const end = this.buffer.indexOf('\n');
          if (end < 0) break;
          const line = this.buffer.slice(0, end).replace(/\r$/, '');
          this.buffer = this.buffer.slice(end + 1);
          if (!line) {
            this.fail('UIA_MODE_VERIFIER_PROTOCOL_INVALID');
            return;
          }
          this.line(line);
          if (this.failure) return;
        }
      });
      this.child.stderr.on('data', () => this.fail('UIA_MODE_VERIFIER_PROTOCOL_INVALID'));
      this.child.stdin.on('error', () => this.fail('UIA_MODE_VERIFIER_PIPE_FAILED'));
      this.child.once('error', () => this.fail('UIA_MODE_VERIFIER_START_FAILED'));
      this.child.once('close', (code, exitSignal) => {
        this.exitResult = { code, signal: exitSignal };
        this.resolveExit(this.exitResult);
        if (!this.closing) this.fail('UIA_MODE_VERIFIER_EXITED');
      });
    }
    try {
      await this.bounded(this.readyPromise, signal, this.startTimeoutMs);
      return { ready: true, readOnly: true, inputSent: false };
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async request(request, { signal } = {}) {
    await this.start({ signal });
    active(signal);
    if (this.pending) throw fault('UIA_MODE_VERIFIER_BUSY');
    if (this.closing) throw fault('UIA_MODE_VERIFIER_CLOSED');
    const id = ++this.sequence,
      line = JSON.stringify({ version: 1, id, request }) + '\n';
    if (Buffer.byteLength(line) > 32768) throw fault('UIA_MODE_VERIFIER_REQUEST_INVALID');
    const response = new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject };
    });
    response.catch(() => {});
    try {
      this.child.stdin.write(line);
    } catch {
      this.fail('UIA_MODE_VERIFIER_PIPE_FAILED');
    }
    try {
      return await this.bounded(response, signal, this.requestTimeoutMs);
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  close() {
    return (this.closePromise ??= (async () => {
      this.closing = true;
      if (!this.child) return { processStopped: true };
      if (!this.ready || this.pending) this.fail('UIA_MODE_VERIFIER_CLOSED');
      else
        try {
          this.child.stdin.end();
        } catch {
          this.fail('UIA_MODE_VERIFIER_PIPE_FAILED');
        }
      const exited = async () => {
        if (this.exitResult) return true;
        let timer;
        try {
          return await Promise.race([
            this.exitPromise.then(() => true),
            new Promise(resolve => {
              timer = setTimeout(() => resolve(false), this.closeTimeoutMs);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      if (!(await exited())) {
        try {
          this.child.kill();
        } catch {}
        if (!(await exited())) throw fault('UIA_MODE_VERIFIER_CLEANUP_UNCONFIRMED');
      }
      return { processStopped: true, forced: !!this.failure || this.exitResult.code !== 0 };
    })().catch(error => {
      this.closePromise = null;
      throw error;
    }));
  }
}

const nativeRefusalCodes = new Set(
  [
    'FAST_LOCATOR_CHANGED',
    'ELEMENT_UNAVAILABLE',
    'LAYOUT_MOVED',
    'LAYOUT_BINDING_CHANGED',
    'LAYOUT_CONTROL_CHANGED',
    'LAYOUT_LABEL_CHANGED',
    'LAYOUT_WINDOW_UNAVAILABLE',
    'ROOT_CHANGED',
    'FAST_DEADLINE',
    'TITLE_CHANGED',
    'TITLE_UNAVAILABLE',
    'TITLE_AMBIGUOUS',
  ].map(value => 'UI_CONTROLS_' + value),
);
function safeNativeRefusal(result, allowTitleRead = false) {
  return object(result) &&
    result.ok === false &&
    result.schemaVersion === 1 &&
    result.readOnly === true &&
    result.inputSent === false &&
    result.messageSendAttempted === false &&
    ((result.namesAndValuesRead === false && result.titleTextRead !== true) ||
      (allowTitleRead && result.namesAndValuesRead === true && result.titleTextRead === true)) &&
    result.searchValueIncluded === false &&
    result.eligibleForAutomation === false &&
    nativeRefusalCodes.has(result.error)
    ? result.error
    : undefined;
}
function missingRootRefusal(result) {
  return (
    object(result) &&
    result.ok === false &&
    result.schemaVersion === 1 &&
    result.error === 'UI_CONTROLS_ROOT_UNAVAILABLE' &&
    result.readOnly === true &&
    result.uiAccessed === true &&
    result.inputSent === false &&
    result.messageSendAttempted === false &&
    result.namesAndValuesRead === false &&
    result.titleTextRead === false &&
    result.searchValueIncluded === false &&
    result.eligibleForAutomation === false
  );
}
function checkedTreeAbsence(result, binding) {
  const observed = [
    'threadId',
    'nativeClassName',
    'visible',
    'minimized',
    'foregroundHwnd',
    'cursorX',
    'cursorY',
    'lastInputTick',
  ];
  if (
    result.schemaVersion !== 1 ||
    result.readOnly !== true ||
    result.inputSent !== false ||
    result.namesAndValuesRead !== false ||
    result.eligibleForAutomation !== false ||
    result.bindingStable !== true ||
    result.complete !== true ||
    result.reason !== null ||
    result.foregroundUnchanged !== true ||
    result.cursorUnchanged !== true ||
    result.inputTickUnchanged !== true ||
    !Number.isInteger(result.mmuiControlCount) ||
    result.mmuiControlCount < 0 ||
    !Number.isInteger(result.nodeCount) ||
    result.nodeCount < 1 ||
    !Array.isArray(result.nodes) ||
    result.nodes.length !== result.nodeCount ||
    result.nodes.some(node => typeof node?.className !== 'string') ||
    result.nodes.filter(node => node.className.startsWith('mmui::')).length !== result.mmuiControlCount ||
    !sameProcess(result.before, binding) ||
    !sameProcess(result.after, binding) ||
    !observed.every(key => result.before[key] !== undefined && result.before[key] === result.after[key]) ||
    !Number.isInteger(result.before.threadId) ||
    result.before.threadId < 1 ||
    typeof result.before.nativeClassName !== 'string' ||
    !['cursorX', 'cursorY', 'lastInputTick'].every(key => Number.isSafeInteger(result.before[key])) ||
    result.before.visible !== true ||
    result.before.minimized !== false ||
    !decimalId(result.before.foregroundHwnd) ||
    result.before.foregroundHwnd === binding.hwnd
  )
    throw fault('UIA_MODE_CONTROLS_UNAVAILABLE');
  return result.mmuiControlCount === 0;
}

/** UIA supplies live control geometry; Qt owns all input, focus handoffs,
 * account/target checks and receipts. No native messaging DLL is loaded. */
export function createUiaControlProvider({
  root,
  configFile,
  executeImpl = execute,
  createVerifier = options => new UiaVerifierClient(options),
  enableOffscreen = false,
  createOffscreen = createUiaOffscreenManager,
  ensureAccessibility,
} = {}) {
  if (
    typeof root !== 'string' ||
    !path.isAbsolute(root) ||
    typeof configFile !== 'string' ||
    !path.isAbsolute(configFile)
  )
    throw fault('UIA_MODE_CONFIG_INVALID');
  if (typeof enableOffscreen !== 'boolean' || typeof createOffscreen !== 'function')
    throw fault('UIA_MODE_CONFIG_INVALID');
  root = path.resolve(root);
  configFile = path.resolve(configFile);
  const offscreen = enableOffscreen ? createOffscreen({ root }) : null;
  let enabledProcess,
    cachedLayout,
    verifier,
    verifierPrimed = false,
    closed = false,
    closePromise,
    ensureQueue = Promise.resolve();
  const controller = new AbortController(),
    inFlight = new Set();
  const providerActive = signal => {
    active(signal);
    if (closed) throw fault('UIA_MODE_VERIFIER_CLOSED');
  };
  async function warmVerifier(signal) {
    providerActive(signal);
    if (!createVerifier) return;
    if (verifier?.failure) {
      await verifier.close();
      providerActive(signal);
      verifier = undefined;
      verifierPrimed = false;
    }
    verifier ??= createVerifier({ root });
    await verifier.start({ signal });
    providerActive(signal);
  }
  async function invokeOnce(helper, mode, request, { signal, write = false } = {}) {
    providerActive(signal);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const executable = path.join(root, 'state/ui-host', helper + '.exe'),
      folder = path.join(root, 'state/ui-runtime/uia-requests');
    noLinks(executable);
    noLinks(folder);
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, crypto.randomUUID() + '.json');
    fs.writeFileSync(file, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
    try {
      let output, failure;
      try {
        output = (
          await executeImpl(executable, [mode, '--request', file, ...(write ? ['--allow-gate-write'] : [])], {
            windowsHide: true,
            shell: false,
            encoding: 'utf8',
            timeout: 15000,
            maxBuffer: 2 * 1024 * 1024,
            signal: combined,
          })
        ).stdout;
      } catch (error) {
        active(signal);
        output = error?.stdout;
        failure = error;
      }
      providerActive(signal);
      let result;
      try {
        result = JSON.parse(output);
      } catch {
        throw fault('UIA_MODE_RESULT_UNCONFIRMED');
      }
      if (failure) {
        const error = fault('UIA_MODE_RESULT_UNCONFIRMED');
        // Keep only a fixed diagnostic code from a confirmed read-only refusal.
        // The verify path separately decides whether a stale locator (or an
        // explicitly authorized post-search role move) permits rediscovery.
        if (
          helper === 'WechatBackgroundControls' &&
          mode === '--verify-layout' &&
          failure.code === 1 &&
          !failure.killed &&
          !failure.signal &&
          failure.stderr === ''
        ) {
          const reason = safeNativeRefusal(result, request.includeConversationFingerprint === true);
          if (reason) error.nativeReason = reason;
        }
        if (
          helper === 'WechatBackgroundControls' &&
          mode === '--layout' &&
          failure.code === 1 &&
          !failure.killed &&
          !failure.signal &&
          failure.stderr === '' &&
          missingRootRefusal(result)
        )
          error.nativeReason = 'UI_CONTROLS_ROOT_UNAVAILABLE';
        throw error;
      }
      if (!object(result) || result.ok !== true) throw fault('UIA_MODE_CONTROLS_UNAVAILABLE');
      return result;
    } finally {
      fs.unlinkSync(file);
    }
  }
  function invoke(...args) {
    const pending = invokeOnce(...args);
    inFlight.add(pending);
    pending.finally(() => inFlight.delete(pending)).catch(() => {});
    return pending;
  }
  async function ensureBound(binding, { signal, config } = {}) {
    providerActive(signal);
    if (!geometry(binding)) throw fault('UIA_MODE_BINDING_INVALID');
    if (sameProcess(enabledProcess, binding)) return;
    config ??= readConfig(configFile);
    let first;
    try {
      first = checkedLayout(
        await invoke('WechatBackgroundControls', '--layout', requestFor(config, binding), { signal }),
        binding,
      );
    } catch (error) {
      if (error.nativeReason !== 'UI_CONTROLS_ROOT_UNAVAILABLE') throw error;
      // A missing root alone lacks stable activity evidence. Obtain a full
      // read-only empty mmui tree before even inspecting the authorized gate.
      const tree = await invoke('WechatBackgroundControls', '--inspect', requestFor(config, binding), { signal });
      if (!checkedTreeAbsence(tree, binding))
        first = checkedLayout(
          await invoke('WechatBackgroundControls', '--layout', requestFor(config, binding), { signal }),
          binding,
        );
    }
    if (first) {
      enabledProcess = structuredClone(binding);
      return first;
    }
    if (typeof ensureAccessibility !== 'function') throw fault('DESKTOP_UIA_ACCESSIBILITY_PROVIDER_REQUIRED');
    await ensureAccessibility({ root, binding: structuredClone(binding), config: structuredClone(config), signal });
    providerActive(signal);
    const result = checkedLayout(
      await invoke('WechatBackgroundControls', '--layout', requestFor(config, binding), { signal }),
      binding,
    );
    enabledProcess = structuredClone(binding);
    return result;
  }
  function ensure(binding, options = {}) {
    const snapshot = structuredClone(binding),
      pending = ensureQueue.then(() => ensureBound(snapshot, options));
    ensureQueue = pending.catch(() => {});
    return pending;
  }
  function checkedObservation(result, binding) {
    if (
      result.readOnly !== true ||
      result.inputSent !== false ||
      result.foregroundUnchanged !== true ||
      result.bindingStable !== true ||
      result.complete !== true ||
      !sameProcess(result.binding, binding) ||
      result.binding.dpi !== binding.dpi ||
      !same(result.binding.clientRect, binding.clientRect) ||
      !same(result.binding.captureRect, binding.captureRect)
    )
      throw fault('UIA_MODE_BINDING_CHANGED');
  }
  function checkedLayout(result, binding) {
    checkedObservation(result, binding);
    if (
      ![result.missing, result.ambiguous].every(
        value => Array.isArray(value) && value.length <= 32 && value.every(key => typeof key === 'string'),
      )
    )
      throw fault('UIA_MODE_LAYOUT_INVALID');
    if (
      result.missing?.some(key => requiredRoles.includes(key)) ||
      result.ambiguous?.some(key => requiredRoles.includes(key))
    )
      throw fault('UIA_MODE_CONTROLS_UNAVAILABLE');
    const client = binding.clientRect;
    if (
      !object(result.layout) ||
      result.layout.width !== client.right ||
      result.layout.height !== client.bottom ||
      result.layout.dpi !== binding.dpi ||
      !['search', 'editor', 'header', 'send'].every(key => rectangle(result.layout[key], client)) ||
      !rectangle(result.voice?.recordStartRect, client) ||
      !rectangle(result.voice?.toolbarRect, client)
    )
      throw fault('UIA_MODE_LAYOUT_INVALID');
    return result;
  }
  const requestFor = (config, binding) => ({
    version: 1,
    hwnd: binding.hwnd,
    pid: binding.pid,
    processCreatedFileTimeUtc: binding.processCreatedFileTimeUtc,
    executable: config.executable,
  });
  async function layout(config, binding, { signal } = {}) {
    if (!geometry(binding)) throw fault('UIA_MODE_BINDING_INVALID');
    const first = await ensure(binding, { signal, config });
    cachedLayout = undefined;
    const result =
        first ??
        checkedLayout(
          await invoke('WechatBackgroundControls', '--layout', requestFor(config, binding), { signal }),
          binding,
        ),
      proof = verificationProof(result);
    if (proof) {
      await warmVerifier(signal);
      cachedLayout = {
        binding: structuredClone(result.binding),
        executable: config.executable,
        proof,
        layout: structuredClone(result.layout),
        voice: structuredClone(result.voice),
        inputTickUnchanged: result.inputTickUnchanged === true,
      };
      if (verifier && !verifierPrimed) {
        // The first actual UIA COM call has additional initialization cost.
        // Pay it while resolving in the background; never reuse its result as
        // the later body-input or submit verification.
        verifierPrimed = true;
        try {
          const primed = await verify(config, binding, { signal, operation: 'background-warmup' });
          if (primed.operation !== 'verify-layout') return primed;
        } catch (error) {
          cachedLayout = undefined;
          throw error;
        }
      }
    }
    return result;
  }
  async function verify(
    config,
    binding,
    { signal, operation, navigationReadiness, allowLayoutRefresh = false, refreshed = false } = {},
  ) {
    providerActive(signal);
    if (!geometry(binding)) throw fault('UIA_MODE_BINDING_INVALID');
    const cached = cachedLayout;
    if (!cached || !sameGeometry(cached.binding, binding) || cached.executable !== config.executable) {
      const result = await layout(config, binding, { signal });
      if (!cachedLayout) {
        if (operation === 'navigation-ready') throw fault('UIA_MODE_READINESS_INVALID');
        return result;
      }
      if (refreshed) throw fault('UIA_MODE_VERIFICATION_INVALID');
      return verify(config, binding, { signal, operation, navigationReadiness, allowLayoutRefresh, refreshed: true });
    }
    const requested = allowLayoutRefresh
      ? requiredRoles
      : ['editor', 'send', 'header', ...(operation === 'voice-start' ? ['recordStart', 'toolbar'] : [])];
    let result;
    try {
      const request = {
        ...requestFor(config, binding),
        verification: cached.proof,
        verifyPhase:
          operation === 'navigation-ready' ? 'navigation-ready' : operation === 'voice-start' ? 'voice-start' : 'input',
        ...([
          'navigation-ready',
          'navigation-continuation',
          'text-input',
          'text-submit',
          'image-input',
          'image-post-paste',
          'image-submit',
          'image-resume',
          'voice-start',
        ].includes(operation)
          ? { includeConversationFingerprint: true }
          : {}),
        ...(operation === 'navigation-ready'
          ? { navigationReadiness: checkedReadinessRequest(navigationReadiness) }
          : {}),
        ...(allowLayoutRefresh ? { refreshNavigationGeometry: true } : {}),
      };
      if (verifier) {
        result = await verifier.request(request, { signal });
        providerActive(signal);
        if (result?.ok !== true) {
          const error = fault('UIA_MODE_RESULT_UNCONFIRMED'),
            reason = safeNativeRefusal(result, request.includeConversationFingerprint === true);
          if (reason) error.nativeReason = reason;
          throw error;
        }
      } else result = await invoke('WechatBackgroundControls', '--verify-layout', request, { signal });
      checkedObservation(result, binding);
    } catch (error) {
      cachedLayout = undefined;
      if (
        (['UI_CONTROLS_FAST_LOCATOR_CHANGED', 'UI_CONTROLS_ELEMENT_UNAVAILABLE'].includes(error.nativeReason) ||
          (allowLayoutRefresh &&
            ['UI_CONTROLS_LAYOUT_MOVED', 'UI_CONTROLS_LAYOUT_CONTROL_CHANGED'].includes(error.nativeReason))) &&
        !refreshed
      ) {
        await layout(config, binding, { signal });
        if (cachedLayout)
          return verify(config, binding, {
            signal,
            operation,
            navigationReadiness,
            allowLayoutRefresh,
            refreshed: true,
          });
      }
      throw error;
    }
    if (
      result.operation !== 'verify-layout' ||
      result.verifiedRoleCount !== requested.length ||
      !same(result.verifiedRoles, requested) ||
      !object(result.controls) ||
      Object.keys(result.controls).length !== requested.length ||
      !object(result.layout) ||
      result.layout.width !== binding.clientRect.right ||
      result.layout.height !== binding.clientRect.bottom ||
      result.layout.dpi !== binding.dpi ||
      result.binding.rootRuntimeIdSha256 !== cached.proof.rootRuntimeIdSha256 ||
      (allowLayoutRefresh && result.navigationGeometryRefreshed !== true) ||
      !requested.every(role => {
        const actual = result.controls[role],
          expected = cached.proof.roles[role];
        return (
          actual &&
          ['runtimeIdSha256', 'className', 'controlType', 'automationId', 'staticLabel'].every(
            key => actual[key] === expected[key],
          ) &&
          same(actual.rect, controlRect(result, role)) &&
          (allowLayoutRefresh ? rectangle(actual.rect, binding.clientRect) : same(actual.rect, expected.rect)) &&
          same(actual.path, expected.path)
        );
      })
    ) {
      cachedLayout = undefined;
      throw fault('UIA_MODE_VERIFICATION_INVALID');
    }
    if (allowLayoutRefresh) {
      checkedLayout(result, binding);
      const proof = verificationProof(result);
      if (!proof) throw fault('UIA_MODE_VERIFICATION_INVALID');
      cachedLayout = {
        binding: structuredClone(result.binding),
        executable: config.executable,
        proof,
        layout: structuredClone(result.layout),
        voice: structuredClone(result.voice),
        inputTickUnchanged: result.inputTickUnchanged === true,
      };
    }
    return result;
  }
  return {
    controlVerificationPolicy: 'input-boundaries-v1',
    navigationPolicy: 'uia-controls-v1',
    ...(offscreen
      ? {
          prepareWindow: request => {
            providerActive(request.signal);
            return offscreen.prepareWindow(request);
          },
        }
      : {}),
    inspectOffscreen: () => offscreen?.getState() ?? null,
    ensure,
    inspectControls: layout,
    async resolveControls({ config, inspection, signal }) {
      providerActive(signal);
      inspectedQtLayoutIdentity(config, inspection);
      if (
        config.executableVersion !== '4.2.0.53' ||
        inspection.executableVersion !== config.executableVersion ||
        inspection.executableSha256 !== config.executableSha256
      )
        throw fault('UIA_MODE_BINDING_CHANGED');
      const popup = resolveQtPopupIdentities({ root, config, searchOnly: true }).searchPopupCalibration;
      const result = await layout(config, inspection.binding, { signal });
      providerActive(signal);
      // Caption geometry belongs to a physical activation fallback, not to
      // control discovery. UIA voice never parks the physical pointer.
      const next = toUiaLayoutConfig(config, {
        layout: result.layout,
        voice: result.voice,
        searchPopupCalibration: popup,
      });
      return { verified: true, proof: 'uia-controls-v1', config: validateQtConfig(next) };
    },
    async verifyControls({ config, binding, signal, operation, navigationReadiness, allowLayoutRefresh = false }) {
      const request = operation === 'navigation-ready' ? checkedReadinessRequest(navigationReadiness) : undefined;
      if (
        typeof allowLayoutRefresh !== 'boolean' ||
        (allowLayoutRefresh && (config.layoutMode !== 'uia-v1' || !request || request.searchPopupHwnd === '0'))
      )
        throw fault('UIA_MODE_READINESS_INVALID');
      // The native image paste proved the same editor while observing its
      // attachment-induced size change. Refresh locators to those exact new
      // bounds before the ordinary strict submit check; never use a tolerance.
      if (
        ['image-submit', 'image-resume', 'text-input', 'text-submit'].includes(operation) &&
        cachedLayout &&
        ['editor', 'send'].some(role => !same(config.layout[role], cachedLayout.layout[role]))
      )
        await layout(config, binding, { signal });
      const result = await verify(config, binding, {
        signal,
        operation,
        navigationReadiness: request,
        allowLayoutRefresh,
      });
      const fingerprint = conversationFingerprint(result.conversationFingerprint, result);
      const navigationReady = request ? checkedReadiness(result.navigationReadiness, request, fingerprint) : undefined;
      const changed =
        !['editor', 'send', 'header'].every(key => same(config.layout[key], result.layout[key])) ||
        (operation === 'voice-start' &&
          (!same(config.voice?.recordStartRect, result.voice.recordStartRect) ||
            !same(voiceToolbar(config), result.voice.toolbarRect))) ||
        (allowLayoutRefresh &&
          cachedLayout &&
          (!same(config.layout.search, cachedLayout.layout.search) ||
            !same(config.voice?.recordStartRect, cachedLayout.voice.recordStartRect) ||
            !same(voiceToolbar(config), cachedLayout.voice.toolbarRect)));
      let navigationLayout;
      if (changed) {
        if (!allowLayoutRefresh) throw fault('UIA_MODE_CONTROLS_CHANGED');
        // An actual search may resize a header/toolbar. Reuse role paths only
        // when their native runtime identities remain exact; otherwise the
        // bounded full scan above is required. Both paths freshly verify the
        // target title/page/editor, while native search generation owns input.
        const cached = cachedLayout;
        if (
          !cached ||
          cached.inputTickUnchanged !== true ||
          result.inputTickUnchanged !== true ||
          !sameGeometry(cached.binding, binding) ||
          !Number.isInteger(binding.threadId) ||
          cached.binding.threadId !== binding.threadId ||
          result.binding.threadId !== binding.threadId ||
          !['editor', 'send', 'header'].every(key => same(cached.layout[key], result.layout[key]))
        )
          throw fault('UIA_MODE_BINDING_CHANGED');
        if (navigationReady.ready)
          navigationLayout = {
            version: 1,
            binding: Object.fromEntries(
              ['hwnd', 'pid', 'threadId', 'processCreatedFileTimeUtc', 'dpi', 'clientRect', 'captureRect'].map(key => [
                key,
                structuredClone(binding[key]),
              ]),
            ),
            layout: Object.fromEntries(
              ['width', 'height', 'dpi', 'search', 'header', 'editor', 'send'].map(key => [
                key,
                structuredClone(cached.layout[key]),
              ]),
            ),
            voice: {
              recordStartRect: structuredClone(cached.voice.recordStartRect),
              toolbarRect: structuredClone(cached.voice.toolbarRect),
            },
          };
      }
      return {
        verified: true,
        proof: 'uia-controls-v1',
        ...(fingerprint ? { conversationFingerprint: fingerprint } : {}),
        ...(request ? { navigationReady } : {}),
        ...(navigationLayout ? { navigationLayout } : {}),
      };
    },
    reset() {
      enabledProcess = undefined;
      cachedLayout = undefined;
    },
    close() {
      return (closePromise ??= (async () => {
        closed = true;
        controller.abort();
        cachedLayout = undefined;
        const result = await Promise.allSettled([verifier?.close(), ...inFlight]);
        let offscreenResult;
        try {
          offscreenResult = await offscreen?.close();
        } finally {
          if (result[0]?.status === 'rejected') throw result[0].reason;
          if (verifier && result[0]?.value?.processStopped !== true)
            throw fault('UIA_MODE_VERIFIER_CLEANUP_UNCONFIRMED');
        }
        return { processStopped: true, ...(offscreen ? { offscreen: offscreenResult } : {}) };
      })().catch(error => {
        closePromise = null;
        throw error;
      }));
    },
  };
}

export function createUiaModeRuntime({
  root,
  hostConfig,
  createClient = options => new QtActionsClient(options),
  createProvider = createUiaControlProvider,
} = {}) {
  let closed = false,
    started = false,
    starting = false,
    client,
    provider,
    cleanupPromise,
    pending,
    closePromise,
    controller,
    gateMayBeEnabled = false;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      const owned = client,
        ownedProvider = provider;
      try {
        const results = await Promise.allSettled([owned?.close(), ownedProvider?.close?.()]);
        for (const result of results) if (result.status === 'rejected') throw result.reason;
      } finally {
        if (client === owned) client = undefined;
        if (provider === ownedProvider) provider = undefined;
      }
    })());
  return {
    async start({ signal } = {}) {
      if (closed || started || starting || signal?.aborted) throw fault('UIA_MODE_LIFECYCLE_INVALID');
      starting = true;
      cleanupPromise = undefined;
      controller = new AbortController();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      pending = (async () => {
        try {
          const config = readConfig(hostConfig);
          provider = createProvider({ root, configFile: hostConfig });
          client = createClient({ root, config, enableInput: false });
          try {
            const inspection = await client.request('inspectLayout');
            active(combined);
            // Validate the observed binding without merging an old calibration
            // into a differently sized current window at startup.
            inspectedQtLayoutIdentity(config, inspection);
            if (
              inspection.executableVersion !== config.executableVersion ||
              inspection.executableSha256 !== config.executableSha256 ||
              !geometry(inspection.binding)
            )
              throw fault('UIA_MODE_BINDING_CHANGED');
            gateMayBeEnabled = true;
            await provider.inspectControls(config, inspection.binding, { signal: combined });
            active(combined);
          } finally {
            await cleanup();
          }
          active(combined);
          if (closed) throw fault('UIA_MODE_ABORTED');
          started = true;
          return { ready: true, backend: 'uia', accessibilityEnabled: true };
        } finally {
          starting = false;
        }
      })();
      return pending;
    },
    close() {
      return (closePromise ??= (async () => {
        closed = true;
        controller?.abort();
        await cleanup();
        await pending?.catch(() => {});
        return { stopped: true, backend: 'uia', accessibilityMayRemainEnabled: gateMayBeEnabled };
      })().catch(error => {
        closePromise = null;
        throw error;
      }));
    },
  };
}
