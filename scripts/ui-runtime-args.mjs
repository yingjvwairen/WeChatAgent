// Explicit Node preloader used by ui-runtime.ps1, never through NODE_OPTIONS.
// Read text arguments after crossing the PowerShell 5.1/native quoting boundary.
import fs from 'node:fs';
import path from 'node:path';

try {
  const marker = process.argv.indexOf('--ui-runtime-args-file', 2);
  const file = process.argv[marker + 1];
  if (marker < 2 || marker !== process.argv.length - 2 || typeof file !== 'string' || !path.isAbsolute(file)) throw new Error();
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 65536) throw new Error();
  const args = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(args) || args.length > 128 || args.some(value => typeof value !== 'string' || value.length > 32768 || value.includes('\0'))) throw new Error();
  process.argv = [...process.argv.slice(0, marker), ...args];
} catch {
  console.error('UI_RUNTIME_ARGUMENTS_INVALID');
  process.exit(1);
}
