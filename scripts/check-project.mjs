import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { qualityBase } from './source-quality-files.mjs';

const root = path.resolve(import.meta.dirname, '..');
const { values } = parseArgs({ options: { 'require-sdk': { type: 'boolean' }, base: { type: 'string' } } });
const base = qualityBase(root, values.base);
if (process.platform !== 'win32') throw Error('The complete check includes Windows native component builds.');
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, windowsHide: true, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
const node = (...args) => run(process.execPath, args);
for (const language of [[], ['--python'], ['--native']])
  node('scripts/format-desktop.mjs', '--check', '--base', base, ...language);
run('git', ['diff', '--check', base, '--']);
node(fileURLToPath(import.meta.resolve('typescript/bin/tsc')), '-p', 'scripts/tsconfig.contracts.json');
node('scripts/run-tests.mjs', ...(values['require-sdk'] ? ['--require-sdk'] : []));
for (const script of ['desktop-sender/build-native.ps1', 'build-accessibility-gate-42053.ps1'])
  run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/' + script, '-SelfTest']);
node('scripts/public-source-check.mjs');
console.log('Source, formatting, regression and native component checks passed.');
