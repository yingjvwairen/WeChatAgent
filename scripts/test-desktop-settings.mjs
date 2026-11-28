import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopSettings, desktopAccountProblem } from './desktop-settings.mjs';

test('first-run configuration has one sender and can be saved before selecting WeChat', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { runtime: { sender: 'wechat-ui' }, input: { controlMode: 'ocr' } };
  assert.equal(desktopSettings(config, root, { requireClient: false }).executable, '');
  assert.throws(() => desktopSettings(config, root), { code: 'DESKTOP_CLIENT_REQUIRED' });
  for (const sender of ['wechat-hook', 'wechat-helper', 'wechat-input']) {
    assert.throws(() => desktopSettings({ ...config, runtime: { sender } }, root, { requireClient: false }), {
      code: 'DESKTOP_BACKEND_REQUIRED',
    });
  }
});

test('UIA and OCR preserve the typing preference while offscreen requires UIA', () => {
  const config = {
    runtime: { sender: 'wechat-ui' },
    input: { wechatExecutable: 'Weixin.exe', controlMode: 'uia', typeText: true, offscreen: true },
  };
  assert.equal(desktopSettings(config, process.cwd()).typeText, true);
  config.input.controlMode = 'ocr';
  assert.throws(() => desktopSettings(config, process.cwd()), { code: 'DESKTOP_OFFSCREEN_REQUIRES_UIA' });
  config.input.offscreen = false;
  assert.equal(desktopSettings(config, process.cwd()).controlMode, 'ocr');
});

test('a ready desktop health report must belong to the single selected live account', () => {
  const health = { backend: 'wechat-ui', version: '4.2.0.53', databaseAccounts: ['wxid_test'], ready: true };
  assert.equal(desktopAccountProblem(health, 'WXID_TEST'), '');
  assert.equal(
    desktopAccountProblem({ ...health, databaseAccounts: ['wxid_other'] }, 'wxid_test'),
    'DESKTOP_ACCOUNT_MISMATCH',
  );
  assert.equal(
    desktopAccountProblem({ ...health, databaseAccounts: ['wxid_test', 'wxid_other'] }, 'wxid_test'),
    'DESKTOP_ACCOUNT_UNVERIFIED',
  );
  assert.equal(desktopAccountProblem({ ...health, ready: false }, 'wxid_test'), 'DESKTOP_NOT_READY');
});
