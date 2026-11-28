import { clipboardBackupDiagnostic } from './clipboard-backup-diagnostic.mjs';
import { clipboardRestorationDiagnostic } from './clipboard-backup-diagnostic.mjs';
import { hash, incompleteForegroundInterval, object } from './qt-contract.mjs';

function clipboardFailureDiagnostic(error) {
  const clipboardBackup = clipboardBackupDiagnostic(error?.clipboardBackup);
  return clipboardBackup ? { clipboardBackup } : {};
}
function clipboardOutcome(report) {
  const restoration = clipboardRestorationDiagnostic(report?.clipboardRestoration);
  return {
    ...(report.clipboardReplaced === true
      ? { clipboardRestored: false, clipboardReplaced: true }
      : { clipboardRestored: true }),
    ...(restoration ? { clipboardRestoration: restoration } : {}),
  };
}
function pixelMismatchDiagnostic(value) {
  return object(value) &&
    Object.keys(value).length === 2 &&
    ['capture', 'guard'].includes(value.stage) &&
    Number.isSafeInteger(value.anchorIndex) &&
    value.anchorIndex >= 0 &&
    value.anchorIndex < 8
    ? { stage: value.stage, anchorIndex: value.anchorIndex }
    : undefined;
}
function imageClipboardDiagnostic(value) {
  const stages = [
    'source',
    'frame',
    'original',
    'before-publish',
    'published',
    'closed',
    'offer',
    'before-input',
    'consumer',
    'restore',
  ];
  const code = v => v === null || (typeof v === 'string' && /^[A-Z][A-Z0-9_]{2,90}$/.test(v));
  if (
    !object(value) ||
    Object.keys(value).length !== 6 ||
    value.version !== 1 ||
    !stages.includes(value.stage) ||
    ![0, 8, 13, 15].includes(value.format) ||
    !code(value.operationFailure) ||
    !code(value.cleanupFailure) ||
    !Array.isArray(value.states) ||
    value.states.length > 10 ||
    !value.states.every(
      s =>
        object(s) &&
        Object.keys(s).length === 4 &&
        stages.includes(s.stage) &&
        Number.isSafeInteger(s.sequence) &&
        s.sequence >= 0 &&
        s.sequence <= 0xffffffff &&
        typeof s.ownerMatched === 'boolean' &&
        (s.formats === null ||
          (Array.isArray(s.formats) &&
            s.formats.length <= 8 &&
            s.formats.every(f => Number.isSafeInteger(f) && f > 0 && f <= 0xffff))),
    )
  )
    return undefined;
  return structuredClone(value);
}
function uiaControlRectDiagnostic(value) {
  const area = r =>
    object(r) &&
    Object.keys(r).length === 4 &&
    ['left', 'top', 'right', 'bottom'].every(key => Number.isSafeInteger(r[key]) && r[key] >= 0 && r[key] <= 8192) &&
    r.right > r.left &&
    r.bottom > r.top;
  if (
    !object(value) ||
    Object.keys(value).length !== 6 ||
    value.version !== 1 ||
    !['image', 'control', 'navigation', 'search'].includes(value.phase) ||
    !['header', 'editor', 'send', 'search'].includes(value.role) ||
    !area(value.expected) ||
    !area(value.observed) ||
    typeof value.inputAttempted !== 'boolean'
  )
    return undefined;
  return structuredClone(value);
}
function quoteMenuSelectionDiagnostic(value) {
  const text = s => s === null || (typeof s === 'string' && s.length <= 256 && !/[\x00-\x1f\x7f]/.test(s)),
    number = n => Number.isFinite(n) && Math.abs(n) <= 65536;
  const area = r =>
    object(r) && Object.keys(r).length === 4 && ['left', 'top', 'right', 'bottom'].every(k => number(r[k]));
  const point = p =>
    object(p) &&
    Object.keys(p).length === 2 &&
    Number.isSafeInteger(p.x) &&
    Number.isSafeInteger(p.y) &&
    number(p.x) &&
    number(p.y);
  const allowed = [
    'version',
    'stage',
    'inputAttempted',
    'messageSendAttempted',
    'itemFound',
    'sameItemRuntime',
    'sameMenuRoot',
    'itemBounds',
    'point',
    'window',
    'rectWithinClient',
    'pointOwned',
    'hit',
    'acceptedEvents',
  ];
  if (
    !object(value) ||
    Object.keys(value).some(k => !allowed.includes(k)) ||
    value.version !== 1 ||
    !['guard', 'item-relookup', 'item-bounds', 'window-binding', 'client-range', 'uia-hit', 'click'].includes(
      value.stage,
    ) ||
    typeof value.inputAttempted !== 'boolean' ||
    value.messageSendAttempted !== false
  )
    return undefined;
  for (const k of ['itemFound', 'sameItemRuntime', 'sameMenuRoot', 'rectWithinClient', 'pointOwned'])
    if (value[k] !== undefined && typeof value[k] !== 'boolean') return undefined;
  if (
    (value.itemBounds && !area(value.itemBounds)) ||
    (value.point && !point(value.point)) ||
    (value.acceptedEvents !== undefined &&
      (!Number.isInteger(value.acceptedEvents) || value.acceptedEvents < 0 || value.acceptedEvents > 3))
  )
    return undefined;
  if (value.window) {
    const w = value.window,
      keys = [
        'hwnd',
        'hitHwnd',
        'pid',
        'threadId',
        'expectedPid',
        'expectedThreadId',
        'owner',
        'ownerMatches',
        'isMain',
        'visible',
        'className',
        'geometryAvailable',
        'client',
        'origin',
        'bounds',
      ];
    if (
      Object.keys(w).length !== keys.length ||
      Object.keys(w).some(k => !keys.includes(k)) ||
      !['hwnd', 'hitHwnd', 'owner'].every(k => typeof w[k] === 'string' && /^\d{1,20}$/.test(w[k])) ||
      !['pid', 'threadId', 'expectedPid', 'expectedThreadId'].every(
        k => Number.isSafeInteger(w[k]) && w[k] >= 0 && w[k] <= 0xffffffff,
      ) ||
      !['ownerMatches', 'isMain', 'visible', 'geometryAvailable'].every(k => typeof w[k] === 'boolean') ||
      !text(w.className) ||
      !area(w.client) ||
      !point(w.origin) ||
      (w.bounds !== null && !area(w.bounds))
    )
      return undefined;
  }
  if (value.hit) {
    const h = value.hit;
    if (
      Object.keys(h).length !== 5 ||
      !['available', 'withinItem', 'sameRuntime'].every(k => typeof h[k] === 'boolean') ||
      !text(h.className) ||
      !text(h.controlType)
    )
      return undefined;
  }
  return structuredClone(value);
}
function popupBindingMismatchDiagnostic(value) {
  const diagnosticRect = value =>
    object(value) &&
    Object.keys(value).length === 4 &&
    ['left', 'top', 'right', 'bottom'].every(
      key => Number.isSafeInteger(value[key]) && Math.abs(value[key]) <= 65536,
    ) &&
    value.right > value.left &&
    value.bottom > value.top;
  const windowFlags = [
      'available',
      'sameBoundWindow',
      'previouslyVisible',
      'visible',
      'minimized',
      'identityReadable',
      'processMatches',
      'threadMatches',
      'classMatches',
      'styleMatches',
      'extendedStyleMatches',
      'dpiMatches',
      'ownerMatches',
      'boundsInsideRoot',
      'observedGeometryAllowed',
    ],
    windowRects = ['windowRectInRoot', 'clientRect', 'clientRectInRoot'];
  const validWindow = window =>
    object(window) &&
    ['available', 'sameBoundWindow', 'previouslyVisible'].every(key => typeof window[key] === 'boolean') &&
    Object.keys(window).every(key =>
      windowFlags.includes(key)
        ? typeof window[key] === 'boolean' ||
          (['ownerMatches', 'observedGeometryAllowed'].includes(key) && window[key] === null)
        : windowRects.includes(key)
          ? diagnosticRect(window[key])
          : key === 'dpi' && Number.isSafeInteger(window[key]) && window[key] >= 0 && window[key] <= 4096,
    );
  const flags = [
    'inputAttempted',
    'readOnly',
    'authorizationGranted',
    'observationAfterFailure',
    'observed',
    'revisionUnchangedBefore',
    'revisionUnchangedAfter',
    'foregroundIsRoot',
    'foregroundIsPopup',
    'enumerationComplete',
  ];
  const areas = [
    'boundWindowRectInRoot',
    'boundClientRect',
    'boundClientRectInRoot',
    'frameWindowRectInRoot',
    'frameClientRect',
  ];
  const fields = [
    'version',
    'stage',
    'pasteStage',
    'kind',
    'boundNow',
    'visibleCandidates',
    'elapsedMs',
    ...flags,
    ...areas,
  ];
  if (
    !object(value) ||
    Object.keys(value).some(key => !fields.includes(key)) ||
    value.version !== 1 ||
    !['bind', 'active', 'frame', 'paste-completion'].includes(value.stage) ||
    ![
      'none',
      'initial-guard',
      'before-publish',
      'before-paste',
      'paste-settle',
      'select-settle',
      'copy-readback',
      'readback-verified',
      'end-settle',
      'clipboard-restored',
      'clipboard-replaced',
    ].includes(value.pasteStage) ||
    !['profile', 'search'].includes(value.kind) ||
    !flags.every(key => typeof value[key] === 'boolean') ||
    value.readOnly !== true ||
    value.authorizationGranted !== false ||
    value.observationAfterFailure !== true ||
    !Number.isSafeInteger(value.elapsedMs) ||
    value.elapsedMs < 0 ||
    value.elapsedMs > 60000 ||
    !areas.slice(0, 3).every(key => diagnosticRect(value[key])) ||
    areas.slice(3).some(key => value[key] !== undefined && !diagnosticRect(value[key])) ||
    !validWindow(value.boundNow) ||
    !Array.isArray(value.visibleCandidates) ||
    value.visibleCandidates.length > 8 ||
    !value.visibleCandidates.every(validWindow)
  )
    return undefined;
  return structuredClone(value);
}
function focusConfirmationDiagnostic(value) {
  if (
    !object(value) ||
    !['attempted', 'accepted', 'confirmed'].every(key => typeof value[key] === 'boolean') ||
    !Number.isSafeInteger(value.elapsedMs) ||
    value.elapsedMs < 0 ||
    value.elapsedMs > 60000 ||
    !['guard-failed', 'foreground-changed', 'request-rejected', 'timeout', 'confirmed'].includes(value.reason)
  )
    return undefined;
  const report = Object.fromEntries(
      ['attempted', 'accepted', 'confirmed', 'elapsedMs', 'reason'].map(key => [key, value[key]]),
    ),
    activation = value.activation;
  const numbers = [
      'currentThreadId',
      'sourceThreadId',
      'targetThreadId',
      'attachError',
      'detachError',
      'foregroundLastError',
    ],
    flags = ['attachmentNeeded', 'attached', 'detached', 'foregroundLastErrorInformational'];
  if (
    object(activation) &&
    numbers.every(
      key => Number.isSafeInteger(activation[key]) && activation[key] >= 0 && activation[key] <= 0xffffffff,
    ) &&
    flags.every(key => typeof activation[key] === 'boolean') &&
    ['not-requested', 'source', 'target', 'none', 'other'].includes(activation.foregroundAfter)
  )
    report.activation = Object.fromEntries(
      [...numbers, ...flags, 'foregroundAfter'].map(key => [key, activation[key]]),
    );
  if (report.activation)
    for (const key of [
      'calibratedClickAttempted',
      'calibratedClickApplied',
      'pointerRestored',
      'returnCaptionConsidered',
      'returnCaptionAttempted',
      'returnCaptionApplied',
      'returnCaptionVerified',
      'returnRaiseAttempted',
      'returnRaiseAccepted',
      'returnRaiseConfirmed',
      'foregroundRequestAccepted',
      'callerWasForegroundProcess',
      'alreadyTargetWithoutClick',
      'calibratedRaiseAttempted',
      'calibratedRaiseAccepted',
      'temporaryTopmostAttempted',
      'temporaryTopmostAccepted',
      'temporaryTopmostRestored',
      'sourceLowerAttempted',
      'sourceLowerAccepted',
      'automaticBlankCaption',
      'offscreenHelperAttempted',
      'offscreenHelperTimedOut',
      'offscreenHelperExited',
      'offscreenHelperActivated',
      'offscreenHelperRequestAttempted',
      'offscreenHelperRequestAccepted',
      'offscreenHelperReportedActivated',
    ])
      if (typeof activation[key] === 'boolean') report.activation[key] = activation[key];
  if (report.activation) {
    if (['source', 'target', 'none', 'other'].includes(activation.foregroundAfterRequest))
      report.activation.foregroundAfterRequest = activation.foregroundAfterRequest;
    for (const key of ['sessionIdleMs', 'foregroundLockTimeoutMs'])
      if (Number.isSafeInteger(activation[key]) && activation[key] >= 0 && activation[key] <= 0xffffffff)
        report.activation[key] = activation[key];
    for (const key of ['sourceMenuOrMoveFlags', 'targetMenuOrMoveFlags'])
      if (
        Number.isInteger(activation[key]) &&
        activation[key] >= 0 &&
        activation[key] <= 0x1e &&
        !(activation[key] & 1)
      )
        report.activation[key] = activation[key];
    if (typeof activation.allPointsOwned === 'boolean') report.activation.allPointsOwned = activation.allPointsOwned;
    for (const key of ['actualRgbaSha256', 'expectedRgbaSha256'])
      if (hash(activation[key])) report.activation[key] = activation[key];
  }
  if (report.activation && Number.isInteger(activation.offscreenHelperExitCode))
    report.activation.offscreenHelperExitCode = activation.offscreenHelperExitCode;
  if (report.activation && /^OFFSCREEN_FOCUS_[A-Z0-9_]{1,80}$/.test(activation.offscreenHelperReason ?? ''))
    report.activation.offscreenHelperReason = activation.offscreenHelperReason;
  const cleanup = activation?.raiseCleanup;
  if (
    report.activation &&
    object(cleanup) &&
    Object.keys(cleanup).length === 4 &&
    typeof cleanup.attempted === 'boolean' &&
    (cleanup.accepted === null || typeof cleanup.accepted === 'boolean') &&
    typeof cleanup.confirmed === 'boolean' &&
    [
      'no-raise',
      'click-attempted',
      'original-order-preserved',
      'guard-pending',
      'restore-timeout',
      'source-order-restored',
      'source-activity-or-binding-changed',
    ].includes(cleanup.reason)
  )
    report.activation.raiseCleanup = {
      attempted: cleanup.attempted,
      accepted: cleanup.accepted,
      confirmed: cleanup.confirmed,
      reason: cleanup.reason,
    };
  return report;
}
function focusRestoreOutcomeDiagnostic(value) {
  const flags = [
    'restored',
    'skipped',
    'foregroundOwnedByWechat',
    'identitiesUnchanged',
    'activityUnchanged',
    'keysReleased',
    'parkRevisionUnchanged',
  ];
  const fields = ['version', 'reason', ...flags],
    reasons = [
      'lease-absent',
      'foreground-not-wechat',
      'identity-changed',
      'activity-changed',
      'keys-held',
      'conditions-satisfied',
      'foreground-check-failed',
      'identity-check-failed',
      'keys-check-failed',
      'restore-confirmation-failed',
      'pointer-restore-failed',
      'restored',
      'park-activity-changed',
    ];
  if (
    !object(value) ||
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some(key => !fields.includes(key)) ||
    value.version !== 1 ||
    !reasons.includes(value.reason) ||
    !flags.every(key => value[key] === null || typeof value[key] === 'boolean')
  )
    return undefined;
  return Object.fromEntries(fields.map(key => [key, value[key]]));
}
function visibilityRestoreOutcomeDiagnostic(value) {
  const flags = [
      'restored',
      'foregroundPreserved',
      'identitiesUnchanged',
      'activityUnchanged',
      'placementUnchanged',
      'topmostUnchanged',
    ],
    extended = object(value) && Object.hasOwn(value, 'temporaryTopmost'),
    fields = ['version', 'reason', ...flags, ...(extended ? ['temporaryTopmost', 'originalFailureCode'] : [])];
  if (
    !object(value) ||
    Object.keys(value).length !== fields.length ||
    value.version !== 1 ||
    !['source-order-restored', 'restore-unconfirmed'].includes(value.reason) ||
    !flags.every(key => typeof value[key] === 'boolean')
  )
    return undefined;
  if (extended) {
    const top = value.temporaryTopmost,
      keys = [
        'originalTargetTopmost',
        'temporaryTopmostAttempted',
        'temporaryTopmostApplied',
        'temporaryTopmostRollbackAttempted',
        'temporaryTopmostRolledBack',
        'topmostRollbackConfirmed',
        'targetDestroyed',
      ];
    if (
      !object(top) ||
      Object.keys(top).length !== keys.length + 1 ||
      top.version !== 1 ||
      !keys.every(key => typeof top[key] === 'boolean') ||
      (value.originalFailureCode !== null && !/^(?:QT_|DRAFT_)[A-Z0-9_]{1,72}$/.test(value.originalFailureCode ?? ''))
    )
      return undefined;
  }
  return Object.fromEntries(fields.map(key => [key, value[key]]));
}
function raisedVisibilityIntervalDiagnostic(value) {
  if (
    !object(value) ||
    Object.keys(value).length !== 5 ||
    value.version !== 1 ||
    value.phase !== 'layout-visibility' ||
    !Number.isSafeInteger(value.durationMs) ||
    value.durationMs < 0 ||
    value.durationMs > 60000 ||
    typeof value.complete !== 'boolean' ||
    value.keyboardFocusChanged !== false
  )
    return undefined;
  return {
    version: 1,
    phase: value.phase,
    durationMs: value.durationMs,
    complete: value.complete,
    keyboardFocusChanged: false,
  };
}
function focusVisibilityDiagnostic(value) {
  const fields = [
    'version',
    'raiseAttempted',
    'requestAccepted',
    'confirmed',
    'initialBlockingCount',
    'lastBlockingCount',
    'elapsedMs',
    'reason',
  ];
  if (
    !object(value) ||
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some(key => !fields.includes(key)) ||
    value.version !== 1 ||
    typeof value.raiseAttempted !== 'boolean' ||
    typeof value.confirmed !== 'boolean' ||
    (value.requestAccepted !== null && typeof value.requestAccepted !== 'boolean') ||
    (!value.raiseAttempted && value.requestAccepted !== null) ||
    !['already-visible', 'raised-visible', 'timeout', 'guard-failed'].includes(value.reason) ||
    !Number.isSafeInteger(value.elapsedMs) ||
    value.elapsedMs < 0 ||
    value.elapsedMs > 60000 ||
    !['initialBlockingCount', 'lastBlockingCount'].every(
      key => value[key] === null || (Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 1000000),
    ) ||
    (value.confirmed &&
      (!['already-visible', 'raised-visible'].includes(value.reason) || value.lastBlockingCount !== 0))
  )
    return undefined;
  return Object.fromEntries(fields.map(key => [key, value[key]]));
}
function focusReturnDiagnostics(value) {
  const focusRestoreOutcome = focusRestoreOutcomeDiagnostic(value?.focusRestoreOutcome),
    focusConfirmation = focusConfirmationDiagnostic(value?.focusConfirmation),
    focusVisibility = focusVisibilityDiagnostic(value?.focusVisibility),
    foregroundInterval = incompleteForegroundInterval(value?.foregroundInterval);
  return {
    ...(focusRestoreOutcome ? { focusRestoreOutcome } : {}),
    ...(focusConfirmation ? { focusConfirmation } : {}),
    ...(focusVisibility ? { focusVisibility } : {}),
    ...(foregroundInterval ? { foregroundInterval } : {}),
  };
}

export {
  clipboardFailureDiagnostic,
  clipboardOutcome,
  pixelMismatchDiagnostic,
  imageClipboardDiagnostic,
  uiaControlRectDiagnostic,
  quoteMenuSelectionDiagnostic,
  popupBindingMismatchDiagnostic,
  focusConfirmationDiagnostic,
  focusRestoreOutcomeDiagnostic,
  visibilityRestoreOutcomeDiagnostic,
  raisedVisibilityIntervalDiagnostic,
  focusVisibilityDiagnostic,
  focusReturnDiagnostics,
};
