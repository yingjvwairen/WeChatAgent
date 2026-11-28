import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { acquireDeliveryLock } from './delivery-lock.mjs';
import { deliveryNoLinks } from './delivery-archive.mjs';
import { codeFor } from './qt-contract.mjs';
import { sanitizeForegroundIntervals } from './foreground-timing.mjs';
import {
  focusConfirmationDiagnostic,
  focusRestoreOutcomeDiagnostic,
  focusVisibilityDiagnostic,
  pixelMismatchDiagnostic,
  raisedVisibilityIntervalDiagnostic,
  visibilityRestoreOutcomeDiagnostic,
} from './qt-diagnostics.mjs';

const foregroundCommands = new Set([
  'beginFocusHandoff',
  'beginForegroundSession',
  'parkFocusHandoff',
  'resumeFocusHandoff',
  'releaseFocusHandoff',
  'transferFocusHandoff',
  'restoreTransferredFocus',
  'captureLayoutRaised',
  'captureLayoutHandoff',
  'click',
  'movePointer',
  'focusUiaEditor',
  'focusUiaReadyEditor',
]);
const preparationCommands = new Set([
  'inspectLayout',
  'captureLayout',
  'capture',
  'captureUiaNavigation',
  'captureUiaControls',
  'checkClearMessageQuote',
  'verifyOpenChatTitle',
  'readDraft',
  'searchEnter',
  'paste',
  'typeText',
  'submitTextEnter',
]);
const preflightWaits = new Set(['QT_ACTIVITY_WARMUP', 'QT_USER_ACTIVE', 'QT_FOCUS_RETURN_WINDOW_REQUIRED']);
const maxBytes = 96 * 1024;
const pendingWrites = new Map();

function describeForegroundCommand({ client, sequence, action, role, startedAt, error, result }) {
  if (
    !/^[a-f0-9]{16}$/.test(client ?? '') ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    !Number.isSafeInteger(startedAt) ||
    startedAt < 1 ||
    startedAt > 8.64e15
  )
    return undefined;
  const preflight = action === 'inspectFocusHandoff';
  const refusal = preflight && result?.ready === false && !preflightWaits.has(result.reason);
  if (!foregroundCommands.has(action) && !refusal && !(error && (preflight || preparationCommands.has(action))))
    return undefined;
  const outcome = error ?? result;
  const confirmation = focusConfirmationDiagnostic(outcome?.focusConfirmation);
  const activation = confirmation?.activation;
  const windowsRequest = activation?.foregroundRequestAccepted;
  const observedContext = activation && {
    callerWasForegroundProcess: activation.callerWasForegroundProcess,
    sessionIdleMs: activation.sessionIdleMs,
    foregroundLockTimeoutMs: activation.foregroundLockTimeoutMs,
    lockTimeoutElapsed:
      activation.sessionIdleMs !== undefined && activation.foregroundLockTimeoutMs !== undefined
        ? activation.sessionIdleMs >= activation.foregroundLockTimeoutMs
        : undefined,
    sourceMenuOrMoveFlags: activation.sourceMenuOrMoveFlags,
    targetMenuOrMoveFlags: activation.targetMenuOrMoveFlags,
    foregroundAfterRequest: activation.foregroundAfterRequest,
    lastObservedForeground: activation.foregroundAfter,
    win32LastError: windowsRequest === undefined ? undefined : activation.foregroundLastError,
    win32LastErrorInformational: windowsRequest === undefined ? undefined : activation.foregroundLastErrorInformational,
    captionExposureAttempted: activation.temporaryTopmostAttempted,
    captionExposureAccepted: activation.temporaryTopmostAccepted,
    captionExposureRestored: activation.temporaryTopmostRestored,
    captionClickAttempted: activation.calibratedClickAttempted,
    captionClickApplied: activation.calibratedClickApplied,
    offscreenHelperActivated: activation.offscreenHelperActivated,
  };
  const finishedAt = Date.now();
  return {
    version: 1,
    at: new Date(startedAt).toISOString(),
    client,
    sequence,
    action,
    ...(['editor', 'search'].includes(role) ? { role } : {}),
    elapsedMs: Math.max(0, finishedAt - startedAt),
    outcome: error ? 'error' : refusal ? 'preflight-refused' : 'completed',
    ...(error || refusal ? { code: codeFor(error ?? { code: outcome.reason }) } : {}),
    ...(typeof outcome?.attempted === 'boolean' ? { inputAttempted: outcome.attempted } : {}),
    ...(typeof outcome?.focusChanged === 'boolean' ? { focusChanged: outcome.focusChanged } : {}),
    ...(typeof outcome?.clipboardRestored === 'boolean' ? { clipboardRestored: outcome.clipboardRestored } : {}),
    ...(confirmation
      ? {
          windowsRequest:
            windowsRequest === true
              ? 'accepted'
              : windowsRequest === false
                ? 'refused'
                : confirmation.attempted === false || activation?.foregroundAfter === 'not-requested'
                  ? 'not-called'
                  : 'unobserved',
          confirmation: confirmation.reason,
          foregroundConfirmed: confirmation.confirmed,
          ...observedContext,
        }
      : preflight
        ? { windowsRequest: 'not-called' }
        : ['beginFocusHandoff', 'resumeFocusHandoff'].includes(action)
          ? { windowsRequest: 'unobserved' }
          : {}),
    restore: focusRestoreOutcomeDiagnostic(outcome?.focusRestoreOutcome),
    visibility: focusVisibilityDiagnostic(outcome?.focusVisibility),
    foregroundInterval: sanitizeForegroundIntervals([outcome?.foregroundInterval])?.[0],
    layoutRestore: visibilityRestoreOutcomeDiagnostic(outcome?.visibilityRestoreOutcome),
    layoutVisibility: raisedVisibilityIntervalDiagnostic(outcome?.raisedVisibilityInterval),
    pixels: pixelMismatchDiagnostic(outcome?.pixelMismatch),
  };
}

async function writeEntries(directory, entries) {
  const file = path.join(directory, 'wechat-foreground.log');
  let lease, temporary;
  try {
    if (!(await fs.stat(directory)).isDirectory()) return;
    lease = acquireDeliveryLock(directory, 'wechat-foreground-log');
    if (!lease) return;
    deliveryNoLinks(file);
    const batch = Buffer.from(entries.join(''));
    const previous = await fs.open(file, 'r').catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    let kept = Buffer.alloc(0);
    if (previous) {
      try {
        const info = await previous.stat();
        if (!info.isFile()) return;
        const size = Math.min(info.size, maxBytes - batch.length);
        const start = info.size - size;
        const bytes = Buffer.alloc(size);
        const { bytesRead } = await previous.read(bytes, 0, size, start);
        const from = start > 0 ? bytes.indexOf(10) + 1 : 0;
        const end = bytes.lastIndexOf(10, bytesRead - 1) + 1;
        if (end > from && (!start || from > 0)) kept = bytes.subarray(from, end);
      } finally {
        await previous.close();
      }
    }
    temporary = file + '.' + crypto.randomUUID() + '.tmp';
    await fs.writeFile(temporary, Buffer.concat([kept, batch]), { flag: 'wx', mode: 0o600 });
    deliveryNoLinks(file);
    await fs.rename(temporary, file);
    temporary = undefined;
  } catch {
    // Diagnostics never decide whether a foreground operation succeeded.
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => {});
    try {
      lease?.release();
    } catch {}
  }
}

/** Local history of foreground operations. Retain only verified scalar facts, never native request data. */
export function recordForegroundDiagnostic(root, command) {
  const entry = describeForegroundCommand(command);
  if (!entry) return;
  const line = JSON.stringify(entry) + '\n';
  if (Buffer.byteLength(line) > 2048) return;
  const directory = path.join(root, 'state', 'logs');
  let queue = pendingWrites.get(directory);
  if (!queue) {
    queue = [];
    pendingWrites.set(directory, queue);
    setImmediate(async () => {
      try {
        while (queue.length) await writeEntries(directory, queue.splice(0));
      } finally {
        pendingWrites.delete(directory);
      }
    });
  }
  // Bounded while the disk is busy as well as after writing.
  queue.push(line);
  if (queue.length > 32) queue.shift();
}
