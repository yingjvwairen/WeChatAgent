import { DESKTOP_WECHAT_VERSION } from '../desktop-settings.mjs';
import { ocrPython } from './ocr-runtime.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import * as qt from './qt-visual-driver.mjs';
import { inspectedQtLayoutIdentity, qtLayoutIdentity, resolveQtPopupIdentities } from './qt-layout-profiles.mjs';
import { validateVoiceRecordingLayout } from './voice-recording-layout.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fault = code => Object.assign(new Error(code), { code, attempted: false, waitable: true });
const exact = (value, keys) =>
  object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const safeCode = value => (/^LAYOUT_[A-Z_]{1,72}$/.test(value ?? '') ? 'UI_QT_' + value : 'UI_QT_LAYOUT_UNAVAILABLE');
const rect = (r, w, h) =>
  exact(r, ['left', 'top', 'right', 'bottom']) &&
  Object.values(r).every(Number.isSafeInteger) &&
  r.left >= 0 &&
  r.top >= 0 &&
  r.right > r.left &&
  r.bottom > r.top &&
  r.right <= w &&
  r.bottom <= h;
const inside = (outer, inner) =>
  inner.left >= outer.left && inner.top >= outer.top && inner.right <= outer.right && inner.bottom <= outer.bottom;
function noLinks(file) {
  for (let at = path.resolve(file); ; at = path.dirname(at)) {
    if (fs.lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('UI_QT_LAYOUT_IMAGE_INVALID');
    if (path.dirname(at) === at) return;
  }
}
function boundImage(root, image, width, height) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 600 ||
    height < 400 ||
    width > 4096 ||
    height > 4096 ||
    width * height > 12000000
  )
    throw fault('UI_QT_LAYOUT_IMAGE_INVALID');
  if (!object(image) || !digest(image.sha256) || typeof image.file !== 'string' || !path.isAbsolute(image.file))
    throw fault('UI_QT_LAYOUT_IMAGE_INVALID');
  const parent = path.resolve(root, 'state/ui-host/qt-frames'),
    file = path.resolve(image.file);
  if (path.dirname(file).toLowerCase() !== parent.toLowerCase() || !/^qt-[a-f0-9]{32}\.png$/.test(path.basename(file)))
    throw fault('UI_QT_LAYOUT_IMAGE_INVALID');
  noLinks(file);
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size < 24 || stat.size > 16 * 1024 * 1024) throw fault('UI_QT_LAYOUT_IMAGE_INVALID');
  const bytes = fs.readFileSync(file);
  if (
    hash(bytes) !== image.sha256 ||
    bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
    bytes.readUInt32BE(16) !== width ||
    bytes.readUInt32BE(20) !== height
  )
    throw fault('UI_QT_LAYOUT_IMAGE_CHANGED');
  return file;
}
function bindingMatches(before, after) {
  return (
    object(after) &&
    ['hwnd', 'pid', 'processCreatedFileTimeUtc', 'dpi'].every(key => before[key] === after[key]) &&
    same(before.clientRect, after.clientRect) &&
    same(before.captureRect, after.captureRect)
  );
}
function readonlyFrame(frame, inspection, handoff = false) {
  if (
    !object(frame) ||
    frame.readOnly !== true ||
    frame.inputSent !== false ||
    frame.focusChanged !== handoff ||
    frame.authorizationGranted !== false ||
    frame.pixelFormat !== 'rgba-row-major-opaque-v1' ||
    frame.token !== undefined ||
    frame.executableVersion !== inspection.executableVersion ||
    !bindingMatches(inspection.binding, frame.binding)
  )
    throw fault('UI_QT_LAYOUT_CAPTURE_INVALID');
}

function temporaryTopmostRestored(value) {
  const flags = [
    'originalTargetTopmost',
    'temporaryTopmostAttempted',
    'temporaryTopmostApplied',
    'temporaryTopmostRollbackAttempted',
    'temporaryTopmostRolledBack',
    'topmostRollbackConfirmed',
    'targetDestroyed',
  ];
  if (
    !exact(value, ['version', ...flags]) ||
    value.version !== 1 ||
    !flags.every(key => typeof value[key] === 'boolean') ||
    value.topmostRollbackConfirmed !== true ||
    value.targetDestroyed
  )
    return false;
  return value.temporaryTopmostAttempted
    ? !value.originalTargetTopmost &&
        value.temporaryTopmostApplied &&
        value.temporaryTopmostRollbackAttempted &&
        value.temporaryTopmostRolledBack
    : !value.temporaryTopmostApplied && !value.temporaryTopmostRollbackAttempted && !value.temporaryTopmostRolledBack;
}
function layoutVisibilityRestored(outcome) {
  return (
    outcome?.version === 1 &&
    outcome.reason === 'source-order-restored' &&
    outcome.restored === true &&
    outcome.foregroundPreserved === true &&
    outcome.identitiesUnchanged === true &&
    outcome.activityUnchanged === true &&
    outcome.placementUnchanged === true &&
    outcome.topmostUnchanged === true &&
    temporaryTopmostRestored(outcome.temporaryTopmost)
  );
}
function restoredLayoutPair(packet, inspection) {
  if (packet?.mode === 'focus-handoff-layout-pair-v1') {
    const interval = packet.foregroundInterval,
      outcome = packet.focusRestoreOutcome;
    if (
      packet.version !== 1 ||
      packet.focusChanged !== true ||
      typeof packet.inputSent !== 'boolean' ||
      packet.chatInputSent !== false ||
      packet.clipboardAccessed !== false ||
      packet.authorizationGranted !== false ||
      packet.restored !== true ||
      packet.activityUnchanged !== true ||
      outcome?.reason !== 'restored' ||
      outcome.restored !== true ||
      outcome.skipped !== false ||
      outcome.identitiesUnchanged !== true ||
      outcome.activityUnchanged !== true ||
      interval?.complete !== true ||
      interval.phase !== 'preparation' ||
      !Number.isSafeInteger(interval.durationMs) ||
      interval.durationMs < 0 ||
      interval.durationMs > 60000 ||
      !Array.isArray(packet.frames) ||
      packet.frames.length !== 2
    )
      throw fault('UI_QT_LAYOUT_FOCUS_RETURN_UNVERIFIED');
    for (const frame of packet.frames) {
      readonlyFrame(frame, inspection, true);
      if (frame.binding.foreground !== true || !Array.isArray(frame.regions) || frame.regions.length)
        throw fault('UI_QT_LAYOUT_CAPTURE_INVALID');
    }
    if (packet.frames[0].image?.file === packet.frames[1].image?.file) throw fault('UI_QT_LAYOUT_CAPTURE_INVALID');
    return packet.frames;
  }
  const interval = packet?.raisedVisibilityInterval;
  if (
    !object(packet) ||
    packet.version !== 1 ||
    packet.mode !== 'visibility-topmost-layout-pair-v1' ||
    packet.focusChanged !== false ||
    packet.inputSent !== false ||
    packet.chatInputSent !== false ||
    packet.clipboardAccessed !== false ||
    packet.authorizationGranted !== false ||
    packet.restored !== true ||
    packet.activityUnchanged !== true ||
    !layoutVisibilityRestored(packet.visibilityRestoreOutcome) ||
    interval?.version !== 1 ||
    interval.phase !== 'layout-visibility' ||
    interval.complete !== true ||
    interval.keyboardFocusChanged !== false ||
    !Number.isSafeInteger(interval.durationMs) ||
    interval.durationMs < 0 ||
    interval.durationMs > 60000 ||
    !['targetRaiseAttempted', 'sourceLowerAttempted', 'restoreRaiseAttempted', 'relativeOrderRestoreAttempted'].every(
      key => typeof packet[key] === 'boolean',
    ) ||
    packet.sourceLowerAttempted !== false ||
    packet.restoreRaiseAttempted !== false ||
    packet.visibilityRestoreOutcome.temporaryTopmost.originalTargetTopmost !== false ||
    packet.targetRaiseAttempted !== packet.visibilityRestoreOutcome.temporaryTopmost.temporaryTopmostAttempted ||
    packet.temporaryTopmostApplied !== packet.visibilityRestoreOutcome.temporaryTopmost.temporaryTopmostApplied ||
    packet.temporaryTopmostRolledBack !== packet.visibilityRestoreOutcome.temporaryTopmost.temporaryTopmostRolledBack ||
    !Array.isArray(packet.frames) ||
    packet.frames.length !== 2
  )
    throw fault('UI_QT_LAYOUT_FOCUS_RETURN_UNVERIFIED');
  for (const frame of packet.frames) {
    readonlyFrame(frame, inspection);
    if (frame.binding.foreground !== false || !Array.isArray(frame.regions) || frame.regions.length !== 0)
      throw fault('UI_QT_LAYOUT_CAPTURE_INVALID');
  }
  if (packet.frames[0].image?.file === packet.frames[1].image?.file) throw fault('UI_QT_LAYOUT_CAPTURE_INVALID');
  return packet.frames;
}
export function unborrowedLayoutRefusal(error) {
  const focus = error?.focusConfirmation,
    outcome = error?.focusRestoreOutcome;
  return (
    error?.code === 'QT_FOCUS_ACQUIRE_UNCONFIRMED' &&
    error.attempted === false &&
    focus?.attempted === true &&
    focus.accepted === false &&
    focus.confirmed === false &&
    focus.reason === 'request-rejected' &&
    outcome?.reason === 'foreground-not-wechat' &&
    outcome.foregroundOwnedByWechat === false &&
    outcome.restored === false &&
    outcome.skipped === true &&
    outcome.identitiesUnchanged === true &&
    outcome.activityUnchanged === true &&
    outcome.keysReleased === true
  );
}

/** Project-owned, isolated Python only. Output contains geometry/hashes, never
 * OCR text; cancellation and protocol failures wait for child termination. */
export async function runQtLayoutPython({
  root,
  script,
  args = [],
  input,
  signal,
  spawnImpl = spawn,
  timeoutMs = 30000,
} = {}) {
  if (
    !['locate-wechat-layout.py', 'qt-auto-layout-image.py'].includes(script) ||
    !Array.isArray(args) ||
    args.some(value => typeof value !== 'string') ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 30000
  )
    throw fault('UI_QT_LAYOUT_OPTIONS_INVALID');
  if (signal?.aborted) throw fault('UI_QT_CANCELLED');
  const python = ocrPython(root),
    file = path.resolve(import.meta.dirname, script);
  for (const target of [python, file]) {
    noLinks(target);
    if (!fs.statSync(target, { throwIfNoEntry: false })?.isFile()) throw fault('UI_QT_LAYOUT_COMPONENT_REQUIRED');
  }
  const payload = input === undefined ? '' : JSON.stringify(input);
  if (Buffer.byteLength(payload) > 65536) throw fault('UI_QT_LAYOUT_OPTIONS_INVALID');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !['PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP'].includes(key.toUpperCase()),
    ),
  );
  return new Promise((resolve, reject) => {
    let child,
      error,
      stdout = [],
      bytes = 0,
      stderrBytes = 0;
    const fail = code => {
      error ??= fault(code);
      try {
        child?.kill();
      } catch {}
    };
    const abort = () => fail('UI_QT_CANCELLED');
    const timer = setTimeout(() => fail('UI_QT_LAYOUT_TIMEOUT'), timeoutMs);
    try {
      child = spawnImpl(python, ['-I', '-B', file, ...args], {
        cwd: root,
        env,
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      clearTimeout(timer);
      reject(fault('UI_QT_LAYOUT_START_FAILED'));
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => fail('UI_QT_LAYOUT_START_FAILED'));
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 65536) fail('UI_QT_LAYOUT_PROTOCOL_INVALID');
      else stdout.push(Buffer.from(chunk));
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > 65536) fail('UI_QT_LAYOUT_PROTOCOL_INVALID');
    });
    child.stdin.on('error', () => fail('UI_QT_LAYOUT_PIPE_FAILED'));
    child.once('close', (code, killed) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) {
        reject(error);
        return;
      }
      let value;
      try {
        value = JSON.parse(Buffer.concat(stdout).toString('utf8'));
      } catch {
        reject(fault('UI_QT_LAYOUT_PROTOCOL_INVALID'));
        return;
      }
      if (killed || code !== 0 || value?.ok !== true) {
        reject(fault(safeCode(value?.code)));
        return;
      }
      resolve(value);
    });
    if (signal?.aborted) abort();
    else child.stdin.end(payload);
  });
}

const requiredLayout = ['header', 'profileOpen', 'search', 'selfOpen', 'editor', 'send', 'focusActivateRect'];
const score = (value, min) => Number.isFinite(value) && value >= min && value <= 1;
const navigationTemplateSha256 = '7f10b2c4d70489b61d2fa1a94cc98f40e3181c77e3f3c4c4894987a83682c005';
function navigationEvidence(row, value) {
  if (!Object.hasOwn(row, 'method')) return !Object.hasOwn(row, 'neutralSupport') && score(row.support, 0.78);
  if (row.method === 'neutral-rgb-step')
    return (
      exact(row, ['kind', 'support', 'method', 'neutralSupport']) &&
      score(row.support, 0.95) &&
      score(row.neutralSupport, 0.78) &&
      row.neutralSupport > 0.78
    );
  if (
    row.method !== 'known-glyph-constellation' ||
    !exact(row, ['kind', 'method', 'templateSha256', 'glyphs']) ||
    row.templateSha256 !== navigationTemplateSha256 ||
    !Array.isArray(row.glyphs) ||
    row.glyphs.length !== 3
  )
    return false;
  const s = value.dpi / 120,
    scale = value.dpi / 96,
    roles = ['contacts', 'box', 'compass'],
    sizes = [
      [26, 26],
      [25, 27],
      [26, 27],
    ],
    centers = [];
  if (
    !row.glyphs.every((glyph, index) => {
      if (
        !exact(glyph, ['kind', 'rect', 'score']) ||
        glyph.kind !== roles[index] ||
        !rect(glyph.rect, value.width, value.height) ||
        !score(glyph.score, 0.93)
      )
        return false;
      const r = glyph.rect,
        w = r.right - r.left,
        h = r.bottom - r.top;
      if (
        r.left < 0 ||
        r.right > Math.round(110 * s) ||
        r.top < Math.round(130 * s) ||
        r.bottom > Math.min(value.height, Math.round(360 * s)) ||
        Math.abs(w - sizes[index][0] * scale) > 2 * scale ||
        Math.abs(h - sizes[index][1] * scale) > 2 * scale
      )
        return false;
      centers.push([(r.left + r.right) / 2, (r.top + r.bottom) / 2]);
      return true;
    })
  )
    return false;
  const xs = centers.map(c => c[0]),
    nav = Math.round(2 * [...xs].sort((a, b) => a - b)[1]),
    avatar = value.layout.selfOpen,
    avatarX = (avatar.left + avatar.right) / 2,
    avatarY = (avatar.top + avatar.bottom) / 2;
  return (
    Number.isSafeInteger(value.anchors.navDivider) &&
    Number.isSafeInteger(value.anchors.chatDivider) &&
    value.anchors.navDivider === nav &&
    nav >= 45 * s &&
    nav <= 110 * s &&
    Math.max(...xs) - Math.min(...xs) <= 1.5 * scale &&
    centers.slice(1).every((c, index) => Math.abs(c[1] - centers[index][1] - 48 * scale) <= 3 * scale) &&
    xs.every(x => Math.abs(x - avatarX) <= 1.5 * scale) &&
    Math.abs(centers[0][1] - avatarY - 100 * scale) <= 4 * scale &&
    value.layout.search.left >= nav + 7 * s &&
    value.layout.search.right <= value.anchors.chatDivider - 30 * s &&
    value.anchors.chatDivider >= nav + 180 * s
  );
}
function measuredEditorEdges(evidence, frame, editor, dpi) {
  const proof = evidence?.innerEdges,
    s = dpi / 120;
  if (
    dpi !== 96 ||
    !same(evidence?.contentRect, editor) ||
    !exact(proof, ['version', 'method', 'left', 'top', 'right']) ||
    proof.version !== 1 ||
    proof.method !== 'signed-frame-gradient-96'
  )
    return false;
  return ['left', 'top', 'right'].every(side => {
    const edge = proof[side];
    if (
      !exact(edge, ['position', 'support']) ||
      !Number.isSafeInteger(edge.position) ||
      edge.position !== editor[side] ||
      !score(edge.support, 0.95)
    )
      return false;
    const inset = side === 'right' ? frame.right - edge.position : edge.position - frame[side];
    return inset >= Math.floor(2 * s) && inset <= Math.ceil(4 * s);
  });
}
function evidenceByKind(value, kinds, code = 'UI_QT_LAYOUT_ANCHORS_UNVERIFIED') {
  if (!Array.isArray(value) || value.length !== kinds.length) throw fault(code);
  const result = new Map();
  for (const row of value) {
    if (!object(row) || !kinds.includes(row.kind) || result.has(row.kind)) throw fault(code);
    result.set(row.kind, row);
  }
  if (result.size !== kinds.length) throw fault(code);
  return result;
}
function pinnedHeaderEvidence(title, value) {
  if (!Object.hasOwn(title, 'headerBanner')) return true;
  const b = title.headerBanner,
    a = value.anchors,
    s = value.dpi / 120,
    icon = b?.iconRect;
  return (
    exact(b, ['method', 'iconRect', 'score', 'separatorY', 'titleRowBottom']) &&
    b.method === 'pinned-message-glyph-and-divider-v1' &&
    score(b.score, 0.94) &&
    rect(icon, value.width, value.height) &&
    [a.chatDivider, a.chromeBottom, a.headerBottom, b.separatorY, b.titleRowBottom].every(Number.isSafeInteger) &&
    b.separatorY > 125 * s &&
    b.separatorY <= 180 * s &&
    b.titleRowBottom >= 70 * s &&
    b.titleRowBottom <= 125 * s &&
    icon.left >= a.chatDivider + Math.round(12 * s) &&
    icon.right <= a.chatDivider + Math.round(55 * s) &&
    icon.top >= a.chromeBottom + Math.round(60 * s) &&
    icon.right - icon.left >= 18 * s &&
    icon.right - icon.left <= 24 * s &&
    icon.bottom - icon.top >= 17 * s &&
    icon.bottom - icon.top <= 22 * s &&
    b.separatorY - icon.bottom >= 14 * s &&
    b.separatorY - icon.bottom <= 35 * s &&
    b.titleRowBottom === icon.top - Math.ceil(8 * s) &&
    a.headerBottom === b.titleRowBottom &&
    value.layout.header.bottom === b.titleRowBottom - Math.round(4 * s) &&
    value.layout.profileOpen.bottom < icon.top &&
    value.layout.search.bottom <= b.titleRowBottom
  );
}
function locatorRegions(value, identity, imageSha256) {
  if (
    !object(value) ||
    value.version !== 1 ||
    value.ok !== true ||
    value.imageSha256 !== imageSha256 ||
    value.width !== identity.width ||
    value.height !== identity.height ||
    value.dpi !== identity.dpi ||
    value.executableVersion !== identity.executableVersion ||
    value.readOnly !== true ||
    value.inputSent !== false ||
    value.emptyDraftAuthorized !== false ||
    value.identityVerified !== false ||
    value.recordingState !== false ||
    !object(value.layout) ||
    requiredLayout.some(key => !rect(value.layout[key], value.width, value.height)) ||
    !object(value.anchors)
  )
    throw fault('UI_QT_LAYOUT_ANCHORS_UNVERIFIED');
  const frame = value.anchors.editorFrame,
    toolbar = value.anchors.toolbar,
    record = value.anchors.recordStartRect,
    editor = value.layout.editor,
    s = value.dpi / 120;
  const e = evidenceByKind(value.evidence, [
    'long-navigation-divider',
    'long-chat-divider',
    'editor-rounded-frame',
    'search-label-and-control',
    'send-label-and-control',
    'record-template',
    'self-avatar-component',
    'chat-title-text',
  ]);
  if (!pinnedHeaderEvidence(e.get('chat-title-text'), value)) throw fault('UI_QT_LAYOUT_ANCHORS_UNVERIFIED');
  const frameEvidence = e.get('editor-rounded-frame');
  const navigation = e.get('long-navigation-divider');
  if (!navigationEvidence(navigation, value)) throw fault('UI_QT_LAYOUT_ANCHORS_UNVERIFIED');
  if (
    !rect(frame, value.width, value.height) ||
    !rect(toolbar, value.width, value.height) ||
    !rect(record, value.width, value.height) ||
    !inside(frame, editor) ||
    !inside(frame, record) ||
    (value.dpi === 96
      ? !measuredEditorEdges(frameEvidence, frame, editor, value.dpi)
      : editor.left !== frame.left + Math.round(3 * s) ||
        editor.top !== frame.top + Math.round(3 * s) ||
        editor.right !== frame.right - Math.round(3 * s) ||
        Object.hasOwn(frameEvidence, 'innerEdges') ||
        Object.hasOwn(frameEvidence, 'contentRect')) ||
    editor.bottom !== Math.min(record.top, value.layout.send.top) ||
    toolbar.top !== editor.bottom
  )
    throw fault('UI_QT_LAYOUT_EDITOR_COVERAGE_UNVERIFIED');
  if (
    !score(e.get('long-chat-divider').support, 0.94) ||
    !score(e.get('search-label-and-control').confidence, 0.97) ||
    !score(e.get('send-label-and-control').confidence, 0.97) ||
    !score(e.get('record-template').score, 0.89) ||
    !same(e.get('editor-rounded-frame').rect, frame) ||
    !same(e.get('self-avatar-component').rect, value.layout.selfOpen) ||
    !same(e.get('chat-title-text').rect, value.layout.profileOpen) ||
    !score(e.get('chat-title-text').confidence, 0.97) ||
    !inside(value.layout.header, value.layout.profileOpen)
  )
    throw fault('UI_QT_LAYOUT_ANCHORS_UNVERIFIED');
  return Object.fromEntries([
    ...requiredLayout.map(key => [key, structuredClone(value.layout[key])]),
    ['recordStartRect', structuredClone(record)],
  ]);
}
function imageEvidence(value, regions, identity, digestValue) {
  if (
    !object(value) ||
    value.version !== 1 ||
    value.ok !== true ||
    value.imageSha256 !== digestValue ||
    value.width !== identity.width ||
    value.height !== identity.height ||
    value.dpi !== identity.dpi ||
    value.readOnly !== true ||
    value.inputSent !== false ||
    value.emptyDraftAuthorized !== false ||
    value.identityVerified !== false ||
    value.fullEditorExamined !== true ||
    typeof value.caretCandidate !== 'boolean' ||
    !exact(value.regionHashes, Object.keys(regions)) ||
    Object.values(value.regionHashes).some(item => !digest(item)) ||
    !Array.isArray(value.emptyEditorSha256s) ||
    value.emptyEditorSha256s.length < 1 ||
    value.emptyEditorSha256s.length > 2 ||
    value.emptyEditorSha256s.some(item => !digest(item)) ||
    new Set(value.emptyEditorSha256s).size !== value.emptyEditorSha256s.length ||
    value.emptyEditorSha256s[0] !== value.regionHashes.editor ||
    value.emptyEditorSha256s.length !== (value.caretCandidate ? 2 : 1)
  )
    throw fault('UI_QT_LAYOUT_EMPTY_TEMPLATE_UNVERIFIED');
  return value;
}

export async function inspectEditorPixels({ root, frame, header, editor, signal }) {
  const { right: width, bottom: height } = frame.binding.clientRect;
  const { dpi } = frame.binding;
  const regions = { header, editor };
  const file = boundImage(root, frame.image, width, height);
  const request = { version: 1, image: file, imageSha256: frame.image.sha256, width, height, dpi, regions };
  const packet = imageEvidence(
    await runQtLayoutPython({ root, script: 'qt-auto-layout-image.py', input: request, signal }),
    regions,
    { width, height, dpi },
    frame.image.sha256,
  );
  if (
    frame.regions[0]?.rgbaSha256 !== packet.regionHashes.header ||
    frame.regions[1]?.rgbaSha256 !== packet.regionHashes.editor
  )
    throw fault('UI_QT_LAYOUT_PIXELS_CHANGED');
  return packet.emptyEditorSha256s;
}

async function captureLayoutReadonly(client, request, signal, onCaptured) {
  const started = performance.now(),
    nativeRequest = qt.QtActionsClient.prototype.request;
  const retryable = client instanceof qt.QtActionsClient && client.request === nativeRequest;
  let previousMismatch;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw fault('UI_QT_CANCELLED');
    if (attempt > 0 && client.request !== nativeRequest) throw previousMismatch;
    let frame;
    try {
      frame = await client.request('captureLayout', request);
    } catch (error) {
      if (signal?.aborted) throw fault('UI_QT_CANCELLED');
      // An unseen, newly resized window has no usable coordinates yet. Leave
      // focus untouched and let the reply queue wait for a visible capture.
      // Only the unchanged native read-only action proves no focus/input took
      // place; diagnostic wrappers can borrow focus before forwarding it.
      if (
        retryable &&
        client.request === nativeRequest &&
        error?.code === 'QT_WINDOW_OBSCURED' &&
        error.attempted === false
      )
        throw fault('UI_QT_LAYOUT_WINDOW_OBSCURED');
      // The native action only reads pixels. A diagnostic proxy may wrap it
      // in focus handoffs, even on a native client instance. Only the original,
      // unchanged native request method is eligible for a retry.
      if (
        !retryable ||
        client.request !== nativeRequest ||
        error?.code !== 'QT_PIXELS_CHANGED' ||
        error.attempted !== false ||
        attempt >= 2 ||
        performance.now() - started + 35 >= 750
      )
        throw error;
      await new Promise((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          reject(fault('UI_QT_CANCELLED'));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', abort);
          resolve();
        }, 35);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
      if (performance.now() - started >= 750) throw error;
      previousMismatch = error;
      continue;
    }
    // Register successful files even if the retry deadline has just elapsed,
    // so the caller's finally can remove them. Protocol checks never retry.
    onCaptured(frame);
    if (signal?.aborted) throw fault('UI_QT_CANCELLED');
    if (attempt > 0 && performance.now() - started >= 750) throw previousMismatch;
    return frame;
  }
}

export function resolveQtAutoLayout(options, dependencies) {
  return resolveQtLayout(options, dependencies);
}

/** First-run layout has no saved coordinates or empty-editor hash. Only the
 * read-only native client may supply its initial current geometry. */
export function resolveQtBootstrapLayout(options, dependencies) {
  const { config, inspection, client } = options,
    binding = inspection?.binding,
    area = binding?.clientRect;
  if (
    !(client instanceof qt.QtActionsClient) ||
    client.enableInput !== false ||
    config?.sharedDesktop !== true ||
    config.executableVersion !== DESKTOP_WECHAT_VERSION ||
    !digest(config.accountRef) ||
    !digest(config.executableSha256) ||
    !path.isAbsolute(config.executable ?? '') ||
    client.config.executable !== config.executable ||
    client.config.executableSha256 !== config.executableSha256 ||
    inspection?.version !== 1 ||
    inspection.readOnly !== true ||
    inspection.inputSent !== false ||
    inspection.focusChanged !== false ||
    inspection.clipboardAccessed !== false ||
    inspection.executableVersion !== config.executableVersion ||
    inspection.executableSha256 !== config.executableSha256 ||
    !object(area) ||
    area.left !== 0 ||
    area.top !== 0 ||
    !rect(area, 4096, 4096) ||
    area.right < 600 ||
    area.bottom < 400 ||
    area.right * area.bottom > 12000000 ||
    !Number.isSafeInteger(binding.pid) ||
    binding.pid < 1 ||
    !/^\d{1,19}$/.test(binding.hwnd ?? '') ||
    !/^\d{1,19}$/.test(binding.processCreatedFileTimeUtc ?? '') ||
    !Number.isSafeInteger(binding.dpi) ||
    binding.dpi < 48 ||
    binding.dpi > 768
  )
    throw fault('UI_QT_BOOTSTRAP_UNVERIFIED');
  const identity = {
    accountRef: config.accountRef,
    executable: path.resolve(config.executable).replaceAll('\\', '/').toLowerCase(),
    executableVersion: config.executableVersion,
    executableSha256: config.executableSha256,
    width: area.right,
    height: area.bottom,
    dpi: binding.dpi,
  };
  return resolveQtLayout(options, dependencies, identity);
}

async function resolveQtLayout(
  { root, config, inspection, signal, client, allowFocusCapture = false },
  {
    runPython = runQtLayoutPython,
    popupCalibration = qt.toObservedPopupCalibration,
    validateConfig = qt.validateQtConfig,
  } = {},
  bootstrapIdentity,
) {
  if (signal?.aborted) throw fault('UI_QT_CANCELLED');
  const identity = bootstrapIdentity ?? inspectedQtLayoutIdentity(config, inspection),
    base = bootstrapIdentity ?? qtLayoutIdentity(config);
  if (
    identity.accountRef !== base.accountRef ||
    identity.executable !== base.executable ||
    identity.executableVersion !== base.executableVersion ||
    identity.executableSha256 !== base.executableSha256
  )
    return null;
  if (typeof popupCalibration !== 'function') throw fault('UI_QT_LAYOUT_COMPONENT_REQUIRED');
  const files = new Set();
  const capture = async request =>
    captureLayoutReadonly(client, request, signal, frame => {
      readonlyFrame(frame, inspection);
      files.add(boundImage(root, frame.image, identity.width, identity.height));
    });
  try {
    // The first full image is a read-only candidate source. Requiring every
    // chat-bubble pixel to remain stable would block on unrelated animations.
    // All input-relevant regions are independently recaptured below.
    let frame, paired;
    try {
      frame = await capture({ regions: [], image: true });
    } catch (error) {
      if (signal?.aborted) throw fault('UI_QT_CANCELLED');
      if (
        allowFocusCapture !== true ||
        error?.code !== 'UI_QT_LAYOUT_WINDOW_OBSCURED' ||
        error.attempted !== false ||
        !(client instanceof qt.QtActionsClient) ||
        client.request !== qt.QtActionsClient.prototype.request
      )
        throw error;
      const expectedBinding = Object.fromEntries(
        ['hwnd', 'pid', 'processCreatedFileTimeUtc', 'dpi', 'clientRect', 'captureRect'].map(key => [
          key,
          structuredClone(inspection.binding[key]),
        ]),
      );
      let packet;
      try {
        if (client.layoutOnlyFocus)
          try {
            packet = await client.request('captureLayoutHandoff', { expectedBinding, idleMs: config.idleMs });
          } catch (error) {
            if (!unborrowedLayoutRefusal(error)) throw error;
            packet = await client.request('captureLayoutRaised', { expectedBinding, idleMs: config.idleMs });
          }
        else packet = await client.request('captureLayoutRaised', { expectedBinding, idleMs: config.idleMs });
      } catch (error) {
        if (error?.code === 'QT_WINDOW_OBSCURED' && layoutVisibilityRestored(error.visibilityRestoreOutcome))
          throw Object.assign(new Error('UI_QT_LAYOUT_VISIBILITY_BLOCKED'), {
            code: 'UI_QT_LAYOUT_VISIBILITY_BLOCKED',
            waitable: false,
            visibilityRestored: true,
          });
        throw error;
      }
      // Register genuine owned files even when a later packet/cancellation
      // check refuses the candidate. No OCR runs before visibility is restored.
      if (Array.isArray(packet?.frames))
        for (const sample of packet.frames.slice(0, 2))
          try {
            files.add(boundImage(root, sample.image, identity.width, identity.height));
          } catch {}
      paired = restoredLayoutPair(packet, inspection);
      [frame] = paired;
      for (const sample of paired) files.add(boundImage(root, sample.image, identity.width, identity.height));
      if (signal?.aborted) throw fault('UI_QT_CANCELLED');
    }
    const file = boundImage(root, frame.image, identity.width, identity.height);
    files.add(file);
    const located = await runPython({
      root,
      script: 'locate-wechat-layout.py',
      args: ['--image', file, '--dpi', String(identity.dpi), '--version', identity.executableVersion],
      signal,
    });
    const regions = locatorRegions(located, identity, frame.image.sha256);
    if (config.sharedDesktop === true) {
      // Layout discovery needs edges and toolbar glyphs, not an empty editor.
      // The shared sender retains its own accepted input prefix separately.
      const keys = requiredLayout.filter(key => key !== 'focusActivateRect');
      const finalInspection = await client.request('inspectLayout');
      if (
        !bindingMatches(inspection.binding, finalInspection?.binding) ||
        finalInspection?.readOnly !== true ||
        finalInspection?.inputSent !== false ||
        finalInspection?.executableSha256 !== identity.executableSha256 ||
        finalInspection?.executableVersion !== identity.executableVersion
      )
        throw fault('UI_QT_LAYOUT_CHANGED');
      const popupIdentities = bootstrapIdentity
        ? { searchPopupCalibration: popupCalibration(config.searchPopupCalibration, 'search') }
        : resolveQtPopupIdentities({ root, config, convert: popupCalibration, searchOnly: true });
      const candidate = {
        ...structuredClone(config),
        layoutMode: 'adaptive-v1',
        hwnd: 'auto',
        ...popupIdentities,
        layout: {
          width: identity.width,
          height: identity.height,
          dpi: identity.dpi,
          ...Object.fromEntries(keys.map(key => [key, regions[key]])),
          pointerParkRect: structuredClone(regions.focusActivateRect),
        },
      };
      const editorFrame = located.anchors.editorFrame,
        s = identity.dpi / 120;
      candidate.voice = {
        recordStartRect: regions.recordStartRect,
        mouseParkRect: regions.focusActivateRect,
        recordingUi: {
          focusHwnd: 'same',
          adaptive: {
            version: 1,
            executableVersion: identity.executableVersion,
            toolbarRect: {
              left: editorFrame.left + Math.round(5 * s),
              top: editorFrame.bottom - Math.round(65 * s),
              right: editorFrame.right - Math.round(5 * s),
              bottom: editorFrame.bottom - Math.round(4 * s),
            },
          },
        },
      };
      validateVoiceRecordingLayout({
        ...candidate.voice,
        clientRect: inspection.binding.clientRect,
        editorRect: regions.editor,
        dpi: identity.dpi,
        allowSameFocus: true,
      });
      return { config: validateConfig(candidate), verified: true, proof: 'verified-edge-anchor-layout-v1' };
    }
    let pixels = imageEvidence(
      await runPython({
        root,
        script: 'qt-auto-layout-image.py',
        input: {
          version: 1,
          image: file,
          imageSha256: frame.image.sha256,
          width: identity.width,
          height: identity.height,
          dpi: identity.dpi,
          regions,
        },
        signal,
      }),
      regions,
      identity,
      frame.image.sha256,
    );
    boundImage(root, frame.image, identity.width, identity.height);
    if (signal?.aborted) throw fault('UI_QT_CANCELLED');
    const after = paired ? paired[1] : await capture({ regions: Object.values(regions), image: true });
    const currentFile = boundImage(root, after.image, identity.width, identity.height);
    files.add(currentFile);
    const keys = Object.keys(regions);
    if (paired) {
      // Both full screenshots were captured during the one visibility transaction.
      // Derive and compare every anchor from the original second PNG after
      // the original foreground is visible again; no foreground visit occurred.
      const current = imageEvidence(
        await runPython({
          root,
          script: 'qt-auto-layout-image.py',
          input: {
            version: 1,
            image: currentFile,
            imageSha256: after.image.sha256,
            width: identity.width,
            height: identity.height,
            dpi: identity.dpi,
            regions,
          },
          signal,
        }),
        regions,
        identity,
        after.image.sha256,
      );
      boundImage(root, after.image, identity.width, identity.height);
      boundImage(root, frame.image, identity.width, identity.height);
      if (
        keys.some(key => key !== 'editor' && current.regionHashes[key] !== pixels.regionHashes[key]) ||
        pixels.emptyEditorSha256s.at(-1) !== current.emptyEditorSha256s.at(-1)
      )
        throw fault('UI_QT_LAYOUT_PIXELS_CHANGED');
      pixels = current;
    } else {
      if (
        after.binding.foreground !== frame.binding.foreground ||
        !Array.isArray(after.regions) ||
        after.regions.length !== keys.length ||
        after.regions.some((item, index) => {
          const key = keys[index];
          return (
            !same(item?.rect, regions[key]) ||
            !digest(item?.rgbaSha256) ||
            (key !== 'editor' && item.rgbaSha256 !== pixels.regionHashes[key])
          );
        })
      )
        throw fault('UI_QT_LAYOUT_PIXELS_CHANGED');
      const editorHash = after.regions[keys.indexOf('editor')].rgbaSha256;
      if (!pixels.emptyEditorSha256s.includes(editorHash)) {
        // A no-caret source cannot predict a later caret's raw hash. Examine the
        // actual second PNG with the same complete-editor validator instead.
        // Both canonical full images must agree; every second-PNG raw region
        // must also equal its native capture. No masks or synthetic hashes.
        const current = imageEvidence(
          await runPython({
            root,
            script: 'qt-auto-layout-image.py',
            input: {
              version: 1,
              image: currentFile,
              imageSha256: after.image.sha256,
              width: identity.width,
              height: identity.height,
              dpi: identity.dpi,
              regions,
            },
            signal,
          }),
          regions,
          identity,
          after.image.sha256,
        );
        boundImage(root, after.image, identity.width, identity.height);
        boundImage(root, frame.image, identity.width, identity.height);
        if (
          after.regions.some((item, index) => item.rgbaSha256 !== current.regionHashes[keys[index]]) ||
          pixels.emptyEditorSha256s.at(-1) !== current.emptyEditorSha256s.at(-1)
        )
          throw fault('UI_QT_LAYOUT_PIXELS_CHANGED');
        // Keep only the candidates proven in this one real current image.
        pixels = current;
      }
    }
    if (signal?.aborted) throw fault('UI_QT_CANCELLED');
    const finalInspection = await client.request('inspectLayout');
    if (
      !bindingMatches(inspection.binding, finalInspection?.binding) ||
      !same(inspectedQtLayoutIdentity(config, finalInspection), identity)
    )
      throw fault('UI_QT_LAYOUT_CHANGED');
    const popupIdentities = resolveQtPopupIdentities({ root, config, convert: popupCalibration });
    const candidate = {
      ...structuredClone(config),
      layoutMode: 'adaptive-v1',
      hwnd: 'auto',
      selfCloseKey: 'Escape',
      profileCloseKey: 'Escape',
      ...popupIdentities,
      layout: {
        width: identity.width,
        height: identity.height,
        dpi: identity.dpi,
        ...Object.fromEntries(
          requiredLayout.filter(key => key !== 'focusActivateRect').map(key => [key, regions[key]]),
        ),
        pointerParkRect: structuredClone(regions.focusActivateRect),
        emptyEditorSha256: pixels.emptyEditorSha256s[0],
        emptyEditorSha256s: [...pixels.emptyEditorSha256s],
        ...(frame.binding.foreground === false
          ? {
              focusActivateRect: regions.focusActivateRect,
              focusActivateRgbaSha256: pixels.regionHashes.focusActivateRect,
            }
          : {}),
      },
    };
    const editorFrame = located.anchors.editorFrame,
      s = identity.dpi / 120;
    const toolbarRect = {
      left: editorFrame.left + Math.round(5 * s),
      top: editorFrame.bottom - Math.round(65 * s),
      right: editorFrame.right - Math.round(5 * s),
      bottom: editorFrame.bottom - Math.round(4 * s),
    };
    candidate.voice = {
      recordStartRect: regions.recordStartRect,
      mouseParkRect: regions.focusActivateRect,
      recordingUi: {
        focusHwnd: 'same',
        adaptive: { version: 1, executableVersion: identity.executableVersion, toolbarRect },
      },
    };
    validateVoiceRecordingLayout({
      ...candidate.voice,
      clientRect: inspection.binding.clientRect,
      editorRect: regions.editor,
      dpi: identity.dpi,
      allowSameFocus: true,
    });
    if (signal?.aborted) throw fault('UI_QT_CANCELLED');
    return { config: validateConfig(candidate), verified: true, proof: 'verified-edge-anchor-layout-v1' };
  } finally {
    for (const file of files) {
      try {
        noLinks(file);
        fs.unlinkSync(file);
      } catch {}
    }
  }
}
