import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const native = process.argv.includes('--native');
const python = process.argv.includes('--python');
const collect = directory =>
  fs.existsSync(directory)
    ? fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? collect(file) : [file];
      })
    : [];
const desktop = collect(path.join(root, 'scripts/desktop-sender'));
const select = (directory, pattern) =>
  fs
    .readdirSync(path.join(root, directory), { withFileTypes: true })
    .filter(entry => entry.isFile() && pattern.test(entry.name))
    .map(entry => path.join(root, directory, entry.name));
const js = [
  ...desktop.filter(file => file.endsWith('.mjs')),
  ...select(
    'scripts',
    /^(?:desktop-[^/]+|local-[^/]+|wechat-onebot|onebot-actions|onebot-events|run-tests|build-source-release|build-installer|installer-package|verify-plugin-release|export-secondary|release-snapshot|test-release-snapshot|voice-send|reader-intake-status|file-delivery-worker|text-delivery-store|import-reply-media|reply-media-catalog)\.mjs$/,
  ),
  ...['delivery-preview', 'reply-delivery-controls', 'social-tool-restrict'].map(name =>
    path.join(root, 'packages/dsh-social-bridge-plugin', name + '.mjs'),
  ),
  path.join(root, 'public/console/workspace-layout.js'),
  path.join(root, 'public/console/local-model-settings.mjs'),
  fileURLToPath(import.meta.url),
].filter(file => fs.existsSync(file));
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
if (native) {
  run(process.env.CLANG_FORMAT ?? 'clang-format', [
    check ? '--dry-run' : '-i',
    '--Werror',
    ...desktop.filter(file => file.endsWith('.cs')),
    ...select('scripts/native-ui', /^WechatAccessibilityGate42053\.cs$/),
  ]);
} else if (python) {
  run(process.env.RUFF ?? 'ruff', [
    'format',
    ...(check ? ['--check'] : []),
    ...desktop.filter(file => file.endsWith('.py')),
    ...select(
      'scripts',
      /^(?:reader-api|reader_(?:http|intake|message_rows|message_binding|payload|poll)|local-[^/]+|local_model_control|prepare-local-gpt-sovits|wechat_(?:video|forwarded|nested_media|reference_media|voice_input))\.py$/,
    ),
  ]);
} else {
  run(process.execPath, [
    fileURLToPath(import.meta.resolve('prettier/bin/prettier.cjs')),
    check ? '--check' : '--write',
    ...new Set(js),
  ]);
}
