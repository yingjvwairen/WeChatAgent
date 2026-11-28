import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { sourceQualityFiles } from './source-quality-files.mjs';

const root = path.resolve(import.meta.dirname, '..');
const { values } = parseArgs({
  options: {
    check: { type: 'boolean' },
    native: { type: 'boolean' },
    python: { type: 'boolean' },
    base: { type: 'string' },
  },
});
if (values.native && values.python) throw Error('Select one source language per formatting invocation.');
const extension = values.native ? /\.cs$/ : values.python ? /\.py$/ : /\.(?:[cm]?js|css)$/;
const files = sourceQualityFiles(root, values.base).filter(file => extension.test(file));
if (!files.length) process.exit(0);
let command, args;
if (values.native) {
  command = process.env.CLANG_FORMAT || 'clang-format';
  args = [values.check ? '--dry-run' : '-i', '--Werror'];
} else if (values.python) {
  command = process.env.RUFF || process.env.WECHATAGENT_TEST_PYTHON || 'python';
  args = [...(process.env.RUFF ? [] : ['-m', 'ruff']), 'format', ...(values.check ? ['--check'] : [])];
} else {
  command = process.execPath;
  args = [fileURLToPath(import.meta.resolve('prettier/bin/prettier.cjs')), values.check ? '--check' : '--write'];
}
// Relative paths and bounded batches also work within Windows' command limit.
for (let at = 0; at < files.length; at += 64) {
  const result = spawnSync(command, [...args, ...files.slice(at, at + 64)], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
