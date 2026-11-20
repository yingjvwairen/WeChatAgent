import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const framework = path.join(process.env.WINDIR ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319');
const available = process.platform === 'win32' && fs.existsSync(path.join(framework, 'csc.exe'));

test('audio route diagnostic compiles and checks formats, virtual-only binding and signal detection without accessing devices', {
  skip: !available && 'Windows .NET Framework x64 compiler is required', timeout: 30000,
}, () => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(root, 'scripts/build-audio-probe.ps1'), '-SelfTest'], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 25000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = result.stdout.split(/\r?\n/).find(line => line.startsWith('{'));
  assert.ok(report, 'native checks must report structured completion');
  const parsed = JSON.parse(report);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.selfTest, true);
  assert.ok(parsed.checks >= 34);
  assert.equal(parsed.audioStarted, false);
  assert.equal(parsed.devicesAccessed, false);
  assert.equal(parsed.recordingSaved, false);
  const invalid = spawnSync(path.join(root, 'state/audio-probe/AudioRouteProbe.exe'), ['--probe'], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  assert.equal(invalid.status, 2);
  assert.deepEqual(JSON.parse(invalid.stdout), {
    ok: false, code: 'AUDIO_ARGUMENTS_INVALID', audioStarted: false, recordingSaved: false,
  });
  const missingRender = spawnSync(path.join(root, 'state/audio-probe/AudioRouteProbe.exe'), ['--play-test'], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  assert.equal(missingRender.status, 2);
  assert.deepEqual(JSON.parse(missingRender.stdout), {
    ok: false, code: 'AUDIO_ARGUMENTS_INVALID', audioStarted: false, recordingSaved: false,
  });
  for (const pid of ['0', '-1', '+1', ' 1', '2147483648']) {
    const invalidPid = spawnSync(path.join(root, 'state/audio-probe/AudioRouteProbe.exe'), ['--capture-sessions', '--pid', pid], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    assert.equal(invalidPid.status, 2);
    assert.deepEqual(JSON.parse(invalidPid.stdout), {
      ok: false, code: 'AUDIO_PID_INVALID', audioStarted: false, recordingSaved: false,
    });
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cable-parent-close-'));
  const file = path.join(directory, 'fixture.wav');
  try {
    const audio = Buffer.alloc(60);
    audio.write('RIFF', 0); audio.writeUInt32LE(52, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16);
    audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28);
    audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(16, 40);
    fs.writeFileSync(file, audio);
    const closedParent = spawnSync(path.join(root, 'state/audio-probe/AudioRouteProbe.exe'), ['--play-wav', '--render-id', 'fixture-never-opened', '--wav', file], {
      cwd: root, encoding: 'utf8', windowsHide: true, input: '', timeout: 10000,
    });
    assert.equal(closedParent.status, 2);
    assert.deepEqual(JSON.parse(closedParent.stdout), {
      ok: false, code: 'AUDIO_PLAYBACK_CANCELLED', audioStarted: false, recordingSaved: false,
    });
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cable-parent-close-'));
    if (fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(directory);
  }
});
