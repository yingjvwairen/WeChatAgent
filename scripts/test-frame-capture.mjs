import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const compiler = path.join(process.env.WINDIR ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const available = process.platform === 'win32' && fs.existsSync(compiler);
const executable = path.join(root, 'state/ui-host/WechatFrameCapture.exe');

test('project frame diagnostic builds and validates geometry/binding/PNG without touching a desktop', {
  skip: !available && 'Windows .NET Framework x64 compiler required', timeout: 20000,
}, () => {
  const build = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/build-frame-capture.ps1'), '-SelfTest'], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(build.error, undefined); assert.equal(build.status, 0, build.stdout + build.stderr);
  const self = JSON.parse(build.stdout.split(/\r?\n/).find(line => line.startsWith('{')));
  assert.equal(self.ok, true); assert.equal(self.mode, 'self-test'); assert.equal(self.checks, 17);
  assert.equal(self.uiAccessed, false); assert.equal(self.captured, false); assert.equal(self.inputSent, false); assert.equal(self.ready, false);
  assert.equal(self.diagnosticOnly, true); assert.equal(self.eligibleForAutomation, false); assert.equal(self.occlusionVerified, false);
});

test('no implicit capture and malformed binding is refused before desktop APIs', { skip: !available }, () => {
  for (const [args, code] of [
    [[], null],
    [['--capture'], 'FRAME_ARGUMENTS_INVALID'],
    [['--capture', '--executable', 'client.exe', '--hwnd', '123'], 'FRAME_EXECUTABLE_ABSOLUTE_REQUIRED'],
    [['--capture', '--executable', 'C:\\fixture\\client.exe', '--hwnd', '-1'], 'FRAME_HWND_INVALID'],
    [['--capture', '--executable', 'C:\\fixture\\client.exe', '--hwnd', '0x123'], 'FRAME_HWND_INVALID'],
    [['--capture', '--executable', 'C:\\fixture\\client.exe', '--hwnd', '1', '--output', 'outside.png'], 'FRAME_ARGUMENTS_INVALID'],
    [['--capture', '--executable', 'C:\\fixture\\client.exe', '--hwnd', '1', '--allow-overlap'], 'FRAME_ARGUMENTS_INVALID'],
  ]) {
    const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    assert.equal(result.error, undefined);
    const report = JSON.parse(result.stdout);
    assert.equal(report.uiAccessed, false); assert.equal(report.captured, false); assert.equal(report.inputSent, false); assert.equal(report.ready, false);
    if (code) { assert.equal(result.status, 1); assert.equal(report.error, code); }
    else { assert.equal(result.status, 0); assert.equal(report.mode, 'help'); }
  }
});
