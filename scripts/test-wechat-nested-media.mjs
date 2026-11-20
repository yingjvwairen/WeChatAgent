import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
test('forwarded attachments bind SQLite identity and actual local image/audio/video bytes', () => {
  const readerPython = path.join(root, 'state/reader/venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const runtimeFile = path.join(root, 'state/ui-runtime.json');
  const runtime = fs.existsSync(runtimeFile) ? JSON.parse(fs.readFileSync(runtimeFile, 'utf8').replace(/^\uFEFF/, '')) : {};
  const python = process.env.WECHATAGENT_TEST_PYTHON || (fs.existsSync(readerPython) ? readerPython : runtime.pythonBase || 'python');
  const result = spawnSync(python, ['-B', '-X', 'utf8', path.join(root, 'scripts/test-wechat-nested-media.py')], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message || 'Nested media tests failed');
});
