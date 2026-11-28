import { spawn } from 'node:child_process';
import {
  clipboardSettled,
  codeFor,
  fault,
  hash,
  incompleteForegroundInterval,
  noLinks,
  object,
  pasteCommands,
  validateQtConfig,
} from './qt-contract.mjs';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { clipboardBackupDiagnostic } from './clipboard-backup-diagnostic.mjs';
import {
  focusConfirmationDiagnostic,
  focusRestoreOutcomeDiagnostic,
  focusVisibilityDiagnostic,
  imageClipboardDiagnostic,
  pixelMismatchDiagnostic,
  popupBindingMismatchDiagnostic,
  quoteMenuSelectionDiagnostic,
  raisedVisibilityIntervalDiagnostic,
  uiaControlRectDiagnostic,
  visibilityRestoreOutcomeDiagnostic,
} from './qt-diagnostics.mjs';

class QtActionsClient {
  constructor({
    root,
    config,
    enableInput = false,
    calibration = false,
    layoutOnlyFocus = false,
    canCapture,
    spawnImpl = spawn,
    timeoutMs = 20000,
    closeTimeoutMs = 3000,
  }) {
    if (typeof layoutOnlyFocus !== 'boolean' || (layoutOnlyFocus && (!calibration || typeof canCapture !== 'function')))
      throw fault('UI_QT_CALIBRATION_OPTIONS_INVALID');
    if (calibration) {
      if (
        enableInput !== false ||
        !object(config) ||
        typeof config.executable !== 'string' ||
        !path.isAbsolute(config.executable) ||
        !hash(config.executableSha256) ||
        config.hwnd !== 'auto'
      )
        throw fault('UI_QT_CALIBRATION_OPTIONS_INVALID');
      this.config = structuredClone(config);
    } else this.config = validateQtConfig(config);
    this.root = path.resolve(root);
    this.spawnImpl = spawnImpl;
    this.enableInput = enableInput;
    this.layoutOnlyFocus = layoutOnlyFocus;
    this.canCapture = canCapture;
    if (
      typeof enableInput !== 'boolean' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 25000 ||
      !Number.isInteger(closeTimeoutMs) ||
      closeTimeoutMs < 10 ||
      closeTimeoutMs > 5000
    )
      throw fault('UI_QT_CLIENT_OPTIONS_INVALID');
    this.timeoutMs = timeoutMs;
    this.closeTimeoutMs = closeTimeoutMs;
    this.sequence = 0;
    this.child = null;
    this.pending = null;
    this.failure = null;
    this.closed = false;
    this.closePromise = null;
    this.stopId = null;
    this.stopAcknowledged = false;
    this.exitResult = null;
    this.cleanupUnconfirmed = false;
  }
  start() {
    if (this.closed || this.failure) throw this.failure ?? fault('UI_QT_CLOSED');
    if (this.child) return;
    const binary = noLinks(path.join(this.root, 'state/ui-host/WechatQtActions.exe'));
    const frames = noLinks(path.join(this.root, 'state/ui-host/qt-frames'));
    if (!fs.statSync(binary, { throwIfNoEntry: false })?.isFile()) throw fault('UI_QT_COMPONENT_MISSING');
    noLinks(this.config.executable);
    if (
      crypto.createHash('sha256').update(fs.readFileSync(this.config.executable)).digest('hex') !==
      this.config.executableSha256
    )
      throw fault('UI_QT_RECALIBRATION_REQUIRED');
    fs.mkdirSync(frames, { recursive: true });
    this.frames = frames;
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.toUpperCase().startsWith('CODEX') &&
          !['NODE_OPTIONS', 'NODE_PATH', 'PYTHONHOME', 'PYTHONPATH'].includes(key.toUpperCase()),
      ),
    );
    const child = this.spawnImpl(
      binary,
      [
        '--executable',
        this.config.executable,
        '--hwnd',
        this.config.hwnd,
        '--frames',
        frames,
        this.layoutOnlyFocus ? '--layout-only' : this.enableInput ? '--enable-input' : '--read-only',
      ],
      { cwd: this.root, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env },
    );
    this.child = child;
    const decoder = new StringDecoder('utf8');
    let buffer = '',
      bytes = 0,
      errBytes = 0;
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) return this.fail(fault('UI_QT_PROTOCOL_INVALID'));
      buffer += decoder.write(chunk);
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        let packet;
        try {
          packet = JSON.parse(buffer.slice(0, index));
        } catch {
          return this.fail(fault('UI_QT_PROTOCOL_INVALID'));
        }
        buffer = buffer.slice(index + 1);
        bytes = Buffer.byteLength(buffer);
        if (packet?.id === null && packet.ok === false) return this.fail(fault(codeFor(packet.error)));
        if (packet?.id === this.stopId && this.stopId !== null) {
          if (packet.ok !== true || packet.result?.stopped !== true || this.stopAcknowledged)
            return this.fail(fault('UI_QT_PROTOCOL_INVALID'));
          this.stopAcknowledged = true;
          continue;
        }
        const pending = this.pending;
        if (!pending || packet?.id !== pending.id || typeof packet.ok !== 'boolean')
          return this.fail(fault('UI_QT_PROTOCOL_INVALID'));
        if (packet.ok && object(packet.result)) this.finishPending(null, packet.result);
        else if (!packet.ok && object(packet.error))
          this.finishPending(
            fault(codeFor(packet.error), {
              nativeAction: pending.action,
              ...(packet.error.attempted === false ? { attempted: false } : {}),
              ...(typeof packet.error.clipboardRestored === 'boolean'
                ? { clipboardRestored: packet.error.clipboardRestored }
                : {}),
              ...(clipboardBackupDiagnostic(packet.error.clipboardBackup)
                ? { clipboardBackup: clipboardBackupDiagnostic(packet.error.clipboardBackup) }
                : {}),
              ...(pending.allowClipboardReplacement &&
              packet.error.clipboardRestored === false &&
              packet.error.clipboardReplaced === true
                ? { clipboardReplaced: true }
                : {}),
              ...(packet.error.originalClipboardBlocked === true &&
              packet.error.attempted === false &&
              packet.error.clipboardRestored === true
                ? { originalClipboardBlocked: true }
                : {}),
              ...(focusConfirmationDiagnostic(packet.error.focusConfirmation)
                ? { focusConfirmation: focusConfirmationDiagnostic(packet.error.focusConfirmation) }
                : {}),
              ...(focusRestoreOutcomeDiagnostic(packet.error.focusRestoreOutcome)
                ? { focusRestoreOutcome: focusRestoreOutcomeDiagnostic(packet.error.focusRestoreOutcome) }
                : {}),
              ...(visibilityRestoreOutcomeDiagnostic(packet.error.visibilityRestoreOutcome)
                ? {
                    visibilityRestoreOutcome: visibilityRestoreOutcomeDiagnostic(packet.error.visibilityRestoreOutcome),
                  }
                : {}),
              ...(raisedVisibilityIntervalDiagnostic(packet.error.raisedVisibilityInterval)
                ? {
                    raisedVisibilityInterval: raisedVisibilityIntervalDiagnostic(packet.error.raisedVisibilityInterval),
                  }
                : {}),
              ...(focusVisibilityDiagnostic(packet.error.focusVisibility)
                ? { focusVisibility: focusVisibilityDiagnostic(packet.error.focusVisibility) }
                : {}),
              ...(incompleteForegroundInterval(packet.error.foregroundInterval)
                ? { foregroundInterval: incompleteForegroundInterval(packet.error.foregroundInterval) }
                : {}),
              ...(packet.error.code === 'QT_PIXELS_CHANGED' && pixelMismatchDiagnostic(packet.error.pixelMismatch)
                ? { pixelMismatch: pixelMismatchDiagnostic(packet.error.pixelMismatch) }
                : {}),
              ...(packet.error.code === 'QT_POPUP_BINDING_CHANGED' &&
              popupBindingMismatchDiagnostic(packet.error.popupBindingMismatch)
                ? { popupBindingMismatch: popupBindingMismatchDiagnostic(packet.error.popupBindingMismatch) }
                : {}),
              ...(imageClipboardDiagnostic(packet.error.imageClipboard)
                ? { imageClipboard: imageClipboardDiagnostic(packet.error.imageClipboard) }
                : {}),
              ...(uiaControlRectDiagnostic(packet.error.uiaControlRect)
                ? { uiaControlRect: uiaControlRectDiagnostic(packet.error.uiaControlRect) }
                : {}),
              ...(quoteMenuSelectionDiagnostic(packet.error.quoteMenuSelection)
                ? { quoteMenuSelection: quoteMenuSelectionDiagnostic(packet.error.quoteMenuSelection) }
                : {}),
            }),
          );
        else {
          this.finishPending(fault('UI_QT_PROTOCOL_INVALID'));
          return this.fail(fault('UI_QT_PROTOCOL_INVALID'));
        }
      }
    });
    child.stderr.on('data', chunk => {
      errBytes += chunk.length;
      if (errBytes > 65536) this.fail(fault('UI_QT_PROTOCOL_INVALID'));
    });
    child.stdin.on('error', () => this.fail(fault('UI_QT_PIPE_FAILED')));
    child.on('error', () => this.fail(fault('UI_QT_START_FAILED')));
    // close follows drained stdout. An exit event can precede the final rollback
    // response and must not reject or kill a helper while that response is in flight.
    this.exitPromise = new Promise(resolve =>
      child.on('close', (code, signal) => {
        this.exitResult = { code, signal };
        if (this.pending) this.finishPending(fault('UI_QT_EXITED'));
        if (!this.closed) this.failure ??= fault('UI_QT_EXITED');
        resolve(this.exitResult);
      }),
    );
  }
  finishPending(error, result) {
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending = null;
    if (
      ['readDraft', 'diagnoseDraftStructure'].includes(pending.action) &&
      result?.clipboardRestored !== true &&
      error?.clipboardRestored !== true &&
      error?.attempted !== false
    )
      this.cleanupUnconfirmed = true;
    // Paste can change the clipboard before it attempts a keystroke. A
    // definite input refusal therefore cannot stand in for rollback evidence.
    if (pasteCommands.has(pending.action) && !clipboardSettled(error ?? result, pending.allowClipboardReplacement))
      this.cleanupUnconfirmed = true;
    if (this.failure || error) pending.reject(this.failure ?? error);
    else pending.resolve(result);
    pending.completed();
  }
  fail(error) {
    this.failure ??= error;
    // Even protocol/time-out failures first stop cooperatively. A forced kill
    // cannot establish whether an in-flight clipboard transaction was restored.
    this.close().catch(() => {});
  }
  request(action, values = {}) {
    if (this.layoutOnlyFocus) {
      if (!['inspectLayout', 'captureLayout', 'captureLayoutHandoff', 'captureLayoutRaised', 'stop'].includes(action))
        return Promise.reject(fault('UI_QT_LAYOUT_ONLY', { attempted: false }));
      if (action !== 'stop' && this.canCapture() !== true)
        return Promise.reject(fault('UI_TARGET_NOT_ALLOWED', { attempted: false }));
    }
    if (
      ![
        'verifyMessageQuote',
        'checkClearMessageQuote',
        'prepareQuoteHistory',
        'attachMessageQuote',
        'scrollOcrQuoteHistory',
        'openOcrQuoteMenu',
        'captureOcrQuoteMenu',
        'chooseOcrQuoteMenu',
        'bindOcrQuotePreview',
        'capture',
        'captureUiaNavigation',
        'captureUiaControls',
        'captureUiaSearch',
        'warmUiaLocators',
        'pasteUiaImage',
        'pasteUiaFile',
        'submitUiaFileDialog',
        'submitUiaImage',
        'resumeUiaImage',
        'openUiaSearch',
        'focusUiaEditor',
        'focusUiaReadyEditor',
        'inspectUiaFocusGeometry',
        'captureLayout',
        'captureLayoutHandoff',
        'captureLayoutRaised',
        'inspectLayout',
        'inspectTargetOcclusion',
        'inspectOcclusion',
        'inspectClipboard',
        'inspectClipboardBackup',
        'inspectQuoteRows',
        'inspectFocusHandoff',
        'inspectFocusActivation',
        'inspectPopup',
        'inspectEmptyEditorPhase',
        'click',
        'movePointer',
        'chord',
        'type',
        'typeText',
        'paste',
        'pasteImage',
        'pasteFile',
        'submitOcrMedia',
        'searchEnter',
        'submitTextEnter',
        'resumeTextEnterProof',
        'readDraft',
        'diagnoseDraftStructure',
        'beginForegroundSession',
        'beginFocusHandoff',
        'parkFocusHandoff',
        'resumeFocusHandoff',
        'transferFocusHandoff',
        'releaseFocusHandoff',
        'restoreTransferredFocus',
        'stop',
      ].includes(action) ||
      !object(values)
    )
      return Promise.reject(fault('UI_QT_REQUEST_INVALID'));
    if (action === 'stop') return this.close().then(() => ({ stopped: true }));
    if (
      !this.enableInput &&
      ![
        'capture',
        'captureLayout',
        'inspectLayout',
        'warmUiaLocators',
        'inspectUiaFocusGeometry',
        'inspectTargetOcclusion',
        'inspectOcclusion',
        'inspectClipboard',
        'inspectClipboardBackup',
        'inspectQuoteRows',
        'inspectFocusHandoff',
        'inspectFocusActivation',
        'inspectPopup',
        'inspectEmptyEditorPhase',
        'stop',
      ].includes(action) &&
      !(this.layoutOnlyFocus && ['captureLayoutHandoff', 'captureLayoutRaised'].includes(action))
    )
      return Promise.reject(fault('UI_QT_INPUT_DISABLED', { attempted: false }));
    this.start();
    if (this.pending) return Promise.reject(fault('UI_QT_BUSY', { attempted: false }));
    const id = ++this.sequence,
      line = JSON.stringify({ ...values, id, action }) + '\n';
    if (Buffer.byteLength(line) > 65536) return Promise.reject(fault('UI_QT_REQUEST_INVALID', { attempted: false }));
    return new Promise((resolve, reject) => {
      let completed;
      const completion = new Promise(done => {
        completed = done;
      });
      const timer = setTimeout(() => this.fail(fault('UI_QT_TIMEOUT')), this.timeoutMs);
      this.pending = {
        id,
        action,
        timer,
        resolve,
        reject,
        completion,
        completed,
        allowClipboardReplacement: pasteCommands.has(action) && values.allowClipboardReplacement === true,
      };
      try {
        this.child.stdin.write(line);
      } catch {
        this.fail(fault('UI_QT_PIPE_FAILED'));
      }
    });
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    if (!this.child) return (this.closePromise = Promise.resolve({ processStopped: true }));
    const active = this.pending;
    if (active) clearTimeout(active.timer);
    this.closePromise = Promise.resolve().then(async () => {
      let timer;
      try {
        if (!this.exitResult) {
          this.stopId = ++this.sequence;
          try {
            this.child.stdin.write(JSON.stringify({ id: this.stopId, action: 'stop' }) + '\n');
          } catch {
            this.failure ??= fault('UI_QT_PIPE_FAILED');
          }
        }
        const [exit] = await Promise.race([
          Promise.all([this.exitPromise, active?.completion ?? Promise.resolve()]),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              this.cleanupUnconfirmed = true;
              this.finishPending(fault('UI_QT_CLEANUP_UNCONFIRMED'));
              try {
                this.child.kill();
              } catch {}
              reject(fault('UI_QT_CLEANUP_UNCONFIRMED'));
            }, this.closeTimeoutMs);
          }),
        ]);
        if (exit.code !== 0 || exit.signal || !this.stopAcknowledged || this.cleanupUnconfirmed)
          throw fault('UI_QT_CLEANUP_UNCONFIRMED');
        return { processStopped: true };
      } finally {
        clearTimeout(timer);
      }
    });
    return this.closePromise;
  }
  waitExited() {
    return this.close();
  }
  release() {
    return this.close();
  }
}

export { QtActionsClient };
