import { DESKTOP_WECHAT_VERSION } from '../desktop-settings.mjs';

// Shared shape validation only. Adaptive geometry is a search boundary for
// bundled native templates, never a learned button or permission to click.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) =>
  object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const rect = value =>
  exact(value, ['left', 'top', 'right', 'bottom']) &&
  Object.values(value).every(Number.isSafeInteger) &&
  value.left >= 0 &&
  value.top >= 0 &&
  value.right > value.left &&
  value.bottom > value.top;
const within = (outer, inner) =>
  rect(outer) &&
  rect(inner) &&
  inner.left >= outer.left &&
  inner.top >= outer.top &&
  inner.right <= outer.right &&
  inner.bottom <= outer.bottom;
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const decimal = value =>
  typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
const fault = code => Object.assign(new Error(code), { code });
export function validVoiceConversationFingerprint(value) {
  return (
    exact(value, [
      'version',
      'scope',
      'sha256',
      'headerRuntimeIdSha256',
      'titleRuntimeIdSha256',
      'textNodeCount',
      'targetVerified',
    ]) &&
    value.version === 1 &&
    value.scope === 'chat-title-text-v1' &&
    [value.sha256, value.headerRuntimeIdSha256, value.titleRuntimeIdSha256].every(hex) &&
    Number.isInteger(value.textNodeCount) &&
    value.textNodeCount >= 1 &&
    value.textNodeCount <= 4 &&
    value.targetVerified === false
  );
}

export function validateVoiceRecordingLayout({
  recordingUi: ui,
  clientRect,
  recordStartRect,
  mouseParkRect: park,
  editorRect,
  dpi,
  allowSameFocus = false,
} = {}) {
  if (
    !within(clientRect, recordStartRect) ||
    recordStartRect.right - recordStartRect.left < 4 ||
    recordStartRect.bottom - recordStartRect.top < 4 ||
    !object(ui) ||
    !(decimal(ui.focusHwnd) || (allowSameFocus && ui.focusHwnd === 'same'))
  )
    throw fault('VOICE_TEMPLATE_INVALID');
  let guards;
  if (Object.hasOwn(ui, 'uia')) {
    const plan = ui.uia,
      hasFingerprint = object(plan) && Object.hasOwn(plan, 'conversationFingerprint');
    if (
      !exact(ui, ['focusHwnd', 'uia']) ||
      !exact(
        plan,
        hasFingerprint ? ['version', 'executableVersion', 'conversationFingerprint'] : ['version', 'executableVersion'],
      ) ||
      plan.version !== 1 ||
      plan.executableVersion !== DESKTOP_WECHAT_VERSION ||
      (!allowSameFocus && !hasFingerprint) ||
      (hasFingerprint && !validVoiceConversationFingerprint(plan.conversationFingerprint))
    )
      throw fault('VOICE_UIA_PLAN_INVALID');
    // Recorder controls are resolved afresh inside the native UIA helper.
    guards = [];
  } else if (Object.hasOwn(ui, 'adaptive')) {
    const adaptive = ui.adaptive,
      toolbar = adaptive?.toolbarRect;
    if (
      !exact(ui, ['focusHwnd', 'adaptive']) ||
      !exact(adaptive, ['version', 'executableVersion', 'toolbarRect']) ||
      adaptive.version !== 1 ||
      adaptive.executableVersion !== DESKTOP_WECHAT_VERSION ||
      !Number.isSafeInteger(dpi) ||
      dpi < 96 ||
      dpi > 240 ||
      !within(clientRect, toolbar) ||
      !within(toolbar, recordStartRect) ||
      toolbar.right - toolbar.left < dpi ||
      toolbar.bottom - toolbar.top < (32 * dpi) / 120 ||
      toolbar.bottom - toolbar.top > dpi ||
      toolbar.top < clientRect.top + (clientRect.bottom - clientRect.top) * 0.45 ||
      toolbar.bottom < clientRect.bottom - (40 * dpi) / 120
    )
      throw fault('VOICE_TEMPLATE_INVALID');
    guards = [toolbar];
  } else {
    if (!exact(ui, ['focusHwnd', 'cancel', 'submit'])) throw fault('VOICE_TEMPLATE_INVALID');
    for (const template of [ui.cancel, ui.submit])
      if (
        !exact(template, ['rect', 'rgbaSha256']) ||
        !hex(template.rgbaSha256) ||
        !within(clientRect, template.rect) ||
        template.rect.right - template.rect.left < 4 ||
        template.rect.right - template.rect.left > 128 ||
        template.rect.bottom - template.rect.top < 4 ||
        template.rect.bottom - template.rect.top > 128
      )
        throw fault('VOICE_TEMPLATE_INVALID');
    if (overlaps(ui.cancel.rect, ui.submit.rect)) throw fault('VOICE_TEMPLATE_INVALID');
    guards = [ui.cancel.rect, ui.submit.rect];
  }
  if (!within(clientRect, editorRect)) throw fault('VOICE_MOUSE_PARK_INVALID');
  // UIA uses directed window messages and never moves the physical pointer.
  // Legacy callers may still supply a real park rectangle; validate it rather
  // than accepting a malformed field or inventing a placeholder when absent.
  if (
    !(Object.hasOwn(ui, 'uia') && park === undefined) &&
    (!within(clientRect, park) ||
      park.right - park.left < 2 ||
      park.right - park.left > 128 ||
      park.bottom - park.top < 2 ||
      park.bottom - park.top > 128 ||
      [editorRect, recordStartRect, ...guards].some(region => overlaps(region, park)))
  )
    throw fault('VOICE_MOUSE_PARK_INVALID');
  return structuredClone(ui);
}

export function sanitizeAdaptiveRecordingUi(value) {
  if (!object(value) || value.requested !== true || typeof value.bound !== 'boolean') return undefined;
  if (!value.bound) return exact(value, ['requested', 'bound']) ? { requested: true, bound: false } : undefined;
  if (
    !exact(value, ['requested', 'bound', 'cancelScore', 'submitScore', 'elapsedMs', 'pixelGuardsFixed']) ||
    value.pixelGuardsFixed !== true ||
    !['cancelScore', 'submitScore'].every(
      key => Number.isFinite(value[key]) && value[key] >= 0.89 && value[key] <= 1,
    ) ||
    !Number.isSafeInteger(value.elapsedMs) ||
    value.elapsedMs < 0 ||
    value.elapsedMs > 30000
  )
    return undefined;
  return structuredClone(value);
}
export function sanitizeUiaRecordingUi(value) {
  const fields = ['version', 'requested', 'bound', 'stateChecks', 'conversationVerified', 'pixelsRead'];
  if (
    !exact(value, Object.hasOwn(value ?? {}, 'startObservation') ? [...fields, 'startObservation'] : fields) ||
    value.version !== 1 ||
    value.requested !== true ||
    typeof value.bound !== 'boolean' ||
    typeof value.conversationVerified !== 'boolean' ||
    value.pixelsRead !== false ||
    !Number.isSafeInteger(value.stateChecks) ||
    value.stateChecks < 0 ||
    value.stateChecks > 100000 ||
    (value.bound && (!value.conversationVerified || value.stateChecks < 1))
  )
    return undefined;
  if (Object.hasOwn(value, 'startObservation')) {
    const v = value.startObservation,
      keys = ['inputMethod', 'afterInputState', 'finalState', 'captureCandidateObserved'];
    const extra = ['pointer', 'beforeUpState', 'captureWhileDown', 'failureFrame'].filter(key =>
      Object.hasOwn(v ?? {}, key),
    );
    const state = name => ['idle', 'recording', 'transition', 'unavailable'].includes(name);
    if (
      !exact(v, [...keys, ...extra]) ||
      !['send-input', 'window-message'].includes(v.inputMethod) ||
      !state(v.afterInputState) ||
      !state(v.finalState) ||
      typeof v.captureCandidateObserved !== 'boolean'
    )
      return undefined;
    if (
      Object.hasOwn(v, 'beforeUpState') !== Object.hasOwn(v, 'captureWhileDown') ||
      (Object.hasOwn(v, 'beforeUpState') &&
        (!state(v.beforeUpState) || (v.captureWhileDown !== null && typeof v.captureWhileDown !== 'boolean')))
    )
      return undefined;
    if (Object.hasOwn(v, 'pointer')) {
      const p = v.pointer,
        point = x =>
          Array.isArray(x) && x.length === 2 && x.every(n => Number.isSafeInteger(n) && Math.abs(n) <= 1000000);
      if (
        v.inputMethod !== 'send-input' ||
        !exact(p, ['expected', 'actual', 'matched', 'pressConsumed']) ||
        !point(p.expected) ||
        (p.actual !== null && !point(p.actual)) ||
        typeof p.matched !== 'boolean' ||
        typeof p.pressConsumed !== 'boolean' ||
        (p.matched && (!p.actual || p.actual.some((n, i) => Math.abs(n - p.expected[i]) > 1))) ||
        (p.pressConsumed && !p.matched)
      )
        return undefined;
    }
    if (Object.hasOwn(v, 'failureFrame')) {
      const f = v.failureFrame;
      if (
        !exact(f, ['file', 'width', 'height', 'scope', 'pixelsRead', 'inputSent']) ||
        !/^voice-start-[a-f0-9]{32}\.png$/.test(f.file) ||
        !Number.isSafeInteger(f.width) ||
        f.width < 1 ||
        f.width > 4096 ||
        !Number.isSafeInteger(f.height) ||
        f.height < 1 ||
        f.height > 512 ||
        f.scope !== 'input-toolbar' ||
        f.pixelsRead !== true ||
        f.inputSent !== false
      )
        return undefined;
    }
  }
  return structuredClone(value);
}

// A background submission never fabricates foreground acquisition. If the
// client activates itself, report the observed return and its measured hold.
// Confirmation remains the bound recorder ending, not a delivery receipt.
export function sanitizeUiaBackgroundSubmit(value, handoff) {
  const fields = ['version', 'attempted', 'applied', 'confirmed', 'foregroundUnchanged'];
  const activated = Object.hasOwn(value ?? {}, 'activationReturn');
  if (
    !exact(value, activated ? [...fields, 'activationReturn'] : fields) ||
    value.version !== 1 ||
    !['attempted', 'applied', 'confirmed', 'foregroundUnchanged'].every(key => typeof value[key] === 'boolean') ||
    (value.applied && !value.attempted) ||
    (value.confirmed && !value.applied) ||
    handoff?.backgroundEntered !== true ||
    handoff.initialReturnConfirmed !== true ||
    handoff.submitActivationAttempted !== false ||
    handoff.submitActivationConfirmed !== false ||
    handoff.submitCaption !== undefined ||
    handoff.submitVisibility !== undefined
  )
    return undefined;
  const submit = handoff.foregroundIntervals?.find(item => item.phase === 'record-submit');
  if (activated) {
    const activation = value.activationReturn;
    const activationFields = ['observed', 'attempted', 'confirmed', 'activityUnchanged'];
    if (
      !exact(
        activation,
        Object.hasOwn(activation ?? {}, 'sourceObservation')
          ? [...activationFields, 'sourceObservation']
          : activationFields,
      ) ||
      activation.observed !== true ||
      !['attempted', 'confirmed', 'activityUnchanged'].every(key => typeof activation[key] === 'boolean') ||
      !value.attempted ||
      !value.applied ||
      value.foregroundUnchanged ||
      (activation.confirmed && !activation.attempted) ||
      (activation.attempted && !activation.activityUnchanged) ||
      handoff.finalReturnAttempted !== activation.attempted ||
      handoff.finalReturnConfirmed !== activation.confirmed ||
      !Number.isSafeInteger(handoff.submitForegroundElapsedMs) ||
      handoff.submitForegroundElapsedMs < 0 ||
      handoff.submitForegroundElapsedMs > 30000 ||
      (submit &&
        (submit.durationMs !== handoff.submitForegroundElapsedMs ||
          submit.includesContactNavigation !== false ||
          submit.complete !== Boolean(value.confirmed && activation.confirmed)))
    )
      return undefined;
    if (Object.hasOwn(activation, 'sourceObservation')) {
      const source = activation.sourceObservation,
        fields = [
          'threadMatched',
          'pidMatched',
          'guiRead',
          'menuInactive',
          'captureReleased',
          'captureOwned',
          'windowBoundsMatched',
        ];
      if (
        !exact(source, fields) ||
        fields.some(field => typeof source[field] !== 'boolean') ||
        (source.captureReleased && source.captureOwned) ||
        (activation.confirmed &&
          (!source.captureReleased ||
            fields.filter(field => field !== 'captureOwned').some(field => source[field] !== true)))
      )
        return undefined;
    }
  } else {
    if (
      handoff.finalReturnAttempted !== false ||
      handoff.finalReturnConfirmed !== false ||
      handoff.submitForegroundElapsedMs !== 0
    )
      return undefined;
    if (
      submit &&
      (submit.durationMs !== 0 ||
        submit.includesContactNavigation !== false ||
        submit.complete !== Boolean(value.confirmed && value.foregroundUnchanged))
    )
      return undefined;
  }
  return structuredClone(value);
}
