import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const framework = path.join(process.env.WINDIR ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319');
const available = process.platform === 'win32' && fs.existsSync(path.join(framework, 'csc.exe'));

test('Windows UI host compiles and validates input encoding without opening windows or injecting input', {
  skip: !available && 'Windows .NET Framework x64 compiler is required', timeout: 30000,
}, () => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(root, 'scripts/build-ui-host.ps1'), '-SelfTest'], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 25000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = result.stdout.split(/\r?\n/).find(line => line.startsWith('{'));
  assert.ok(report, 'host must report the completed native checks');
  const parsed = JSON.parse(report);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.selfTest, true);
  assert.ok(parsed.checks >= 15);
  assert.equal(parsed.uiAccessed, false);
  assert.equal(parsed.inputSent, false);
});
