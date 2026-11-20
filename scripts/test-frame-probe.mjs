import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateFrameCapture, inspectWechatWindow } from './frame-probe.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-frame-contract-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('wechat-frame-contract-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  // Header fixture for protocol checks, not an image-decoding/OCR test.
  const bytes = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12); bytes.writeUInt32BE(100, 16); bytes.writeUInt32BE(50, 20); bytes[24] = 8; bytes[25] = 2;
  const file = path.join(directory, `wechat-frame-${randomUUID()}.png`);
  fs.writeFileSync(file, bytes);
  const binding = { executable: path.join(directory, 'Weixin.exe'), hwnd: '123', allowOverlap: false };
  const sample = { hwnd: '123', executable: binding.executable, pid: 4, threadId: 5, processCreatedFileTimeUtc: '12345', dpi: 120, sessionId: 1,
    foregroundMatched: true, visible: true, minimized: false, inputDesktopMatched: true, overlappingWindows: [],
    captureRect: { left: 10, top: 20, right: 110, bottom: 70, width: 100, height: 50 } };
  const report = { ok: true, mode: 'window-frame-diagnostic', method: 'gdi-screen-client-area-srccopy', readOnly: true, captured: true,
    imageSaved: true, inputSent: false, ready: false, diagnosticOnly: true, eligibleForAutomation: false, occlusionVerified: false,
    bindingStable: true, diagnosticOverlapAllowed: false, accountVerified: false, targetVerified: false, draftVerified: false, focusVerified: false,
    image: { file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, width: 100, height: 50, sourcePixelFormat: 'Format32bppRgb',
      sourceStride: 400, pngBitDepth: 8, pngColorType: 2, scaled: false }, before: structuredClone(sample), after: structuredClone(sample),
    occlusion: { ownedPopupCheckPassed: true, allOverlaysVerified: false } };
  return { directory, binding, report, options: { diagnosticsRoot: directory } };
}

test('capture metadata remains diagnostic and omits arbitrary private native fields', t => {
  const { report, binding, options } = fixture(t);
  report.privateText = 'private fixture';
  const result = validateFrameCapture(report, binding, options);
  assert.equal(result.window.dpi, 120); assert.equal(result.eligibleForAutomation, false);
  assert.equal(result.diagnosticOnly, true); assert.equal(result.privateText, undefined);
});

test('capture cannot promote OCR to input permission or change native identity binding', t => {
  const { report, binding, options } = fixture(t);
  for (const key of ['ready', 'eligibleForAutomation', 'occlusionVerified', 'inputSent', 'accountVerified', 'targetVerified']) {
    const changed = structuredClone(report); changed[key] = true;
    assert.throws(() => validateFrameCapture(changed, binding, options), { code: 'FRAME_PROTOCOL_INVALID' });
  }
  for (const key of ['pid', 'threadId', 'dpi', 'processCreatedFileTimeUtc', 'sessionId', 'hwnd']) {
    const changed = structuredClone(report); changed.after[key] = key === 'hwnd' || key === 'processCreatedFileTimeUtc' ? '9' : 9;
    assert.throws(() => validateFrameCapture(changed, binding, options), { code: 'FRAME_BINDING_INVALID' });
  }
});

test('overlap requires explicit diagnostic choice and remains ineligible', t => {
  const { report, binding, options } = fixture(t);
  report.before.overlappingWindows = [{ class: 'fixture' }];
  assert.throws(() => validateFrameCapture(report, binding, options), { code: 'FRAME_BINDING_INVALID' });
  report.diagnosticOverlapAllowed = true; binding.allowOverlap = true;
  assert.equal(validateFrameCapture(report, binding, options).overlap.before, 1);
  assert.equal(validateFrameCapture(report, binding, options).eligibleForAutomation, false);
});

test('saved pixels must match hash, dimensions and bounded path', t => {
  const { report, binding, options } = fixture(t);
  const changed = structuredClone(report); changed.image.sha256 = '0'.repeat(64);
  assert.throws(() => validateFrameCapture(changed, binding, options), { code: 'FRAME_IMAGE_CHANGED' });
  const wrongPath = structuredClone(report); wrongPath.image.file = path.join(path.dirname(options.diagnosticsRoot), path.basename(report.image.file));
  assert.throws(() => validateFrameCapture(wrongPath, binding, options), { code: 'FRAME_IMAGE_PATH_INVALID' });
  const bytes = fs.readFileSync(report.image.file); bytes.writeUInt32BE(99, 16); fs.writeFileSync(report.image.file, bytes);
  assert.throws(() => validateFrameCapture(report, binding, options), { code: 'FRAME_IMAGE_CHANGED' });
});

test('invalid requests fail before any native capture', async () => {
  for (const options of [{}, { executable: 'Weixin.exe', hwnd: '1', expectedTitle: 'fixture' },
    { executable: path.resolve('Weixin.exe'), hwnd: '-1', expectedTitle: 'fixture' },
    { executable: path.resolve('Weixin.exe'), hwnd: '9223372036854775808', expectedTitle: 'fixture' },
    { executable: path.resolve('Weixin.exe'), hwnd: '1', expectedTitle: 'fixture', allowOverlap: 'true' }]) {
    await assert.rejects(inspectWechatWindow(options), { code: 'FRAME_OPTIONS_INVALID' });
  }
});
