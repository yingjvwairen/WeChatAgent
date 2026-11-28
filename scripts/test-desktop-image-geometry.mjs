import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { QtVisualDriver } from './desktop-sender/qt-visual-driver.mjs';
const rect = (left, top, right, bottom) => ({ left, top, right, bottom });
function fixture() {
  const config = {
    version: 1,
    backend: 'qt-visual',
    sharedDesktop: true,
    layoutMode: 'uia-v1',
    focusActivationMode: 'uia-caption-v1',
    account: 'self',
    accountRef: 'a'.repeat(64),
    executable: path.resolve('fixture/Weixin.exe'),
    executableVersion: '4.2.0.53',
    executableSha256: 'b'.repeat(64),
    hwnd: 'auto',
    idleMs: 1000,
    ocrBackend: 'windows',
    searchPopupCalibration: {
      version: 1,
      kind: 'search',
      className: 'fixture',
      ownerRelation: 'root-owned',
      ownerDepth: 1,
      style: 0,
      extendedStyle: 0,
    },
    layout: {
      width: 1023,
      height: 773,
      dpi: 120,
      search: rect(122, 57, 253, 82),
      header: rect(321, 39, 1017, 99),
      editor: rect(346, 603, 997, 701),
      send: rect(932, 712, 992, 745),
    },
  };
  const binding = {
    hwnd: '1',
    pid: 2,
    threadId: 3,
    processCreatedFileTimeUtc: '134000000000000000',
    dpi: 120,
    clientRect: rect(0, 0, 1023, 773),
    captureRect: rect(0, 214, 1023, 987),
  };
  const current = { epoch: 'a', revision: 4, binding };
  const frame = {
    epoch: 'a',
    revision: 4,
    binding: structuredClone(binding),
    regions: [
      { role: 'header', rect: config.layout.header },
      { role: 'editor', rect: rect(346, 542, 997, 702) },
      { role: 'send', rect: config.layout.send },
    ],
  };
  const unexpected = () => assert.fail('geometry validation must not access the desktop');
  const driver = new QtVisualDriver({
    root: path.resolve('.'),
    config,
    client: { request: unexpected },
    resolveTarget: unexpected,
    verifyControls: unexpected,
    navigationPolicy: 'uia-controls-v1',
    controlVerificationPolicy: 'input-boundaries-v1',
  });
  return { driver, current, frame };
}
test('an owned inline image adopts the exact grown editor rectangle without changing the window or header', () => {
  const f = fixture();
  f.driver.acceptPastedImageGeometry(f.frame, f.current);
  assert.deepEqual(f.driver.config.layout.editor, rect(346, 542, 997, 702));
  assert.deepEqual(f.driver.config.layout.header, rect(321, 39, 1017, 99));
});
test('a different window, human-input generation or header cannot rebind image geometry', () => {
  for (const mutate of [
    f => f.frame.binding.pid++,
    f => f.frame.revision++,
    f => f.frame.binding.captureRect.left++,
    f => (f.frame.regions[0].rect = rect(320, 39, 1017, 99)),
    f => (f.frame.regions[1].rect = rect(346, 542, 1100, 702)),
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => f.driver.acceptPastedImageGeometry(f.frame, f.current));
    assert.deepEqual(f.driver.config.layout.editor, rect(346, 603, 997, 701));
  }
});
