import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

export function qualityBase(root, base = process.env.WECHATAGENT_QUALITY_BASE) {
  if (base) return base;
  for (const candidate of ['v0.4.5', '448c7f4bc791b365327936fa2f1de9b438c55efb']) {
    const ref = spawnSync('git', ['rev-parse', '--verify', '--quiet', candidate + '^{commit}'], {
      cwd: root,
      windowsHide: true,
    });
    if (ref.error) throw ref.error;
    if (ref.status === 0) return candidate;
  }
  throw Error('QUALITY_BASE_UNAVAILABLE: fetch the upstream PR base or supply an available commit with --base.');
}

// Always check the desktop sender and include changes relative to the selected
// ref. A shallow checkout needs the actual base object to check the whole PR.
export function sourceQualityFiles(root, base) {
  const git = args =>
    execFileSync('git', args, {
      cwd: root,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    })
      .split('\0')
      .filter(Boolean);
  const files = new Set([
    ...git(['ls-files', '--cached', '-z', '--', 'scripts/desktop-sender/']),
    ...git(['diff', '--name-only', '--diff-filter=ACMR', '-z', qualityBase(root, base), '--']),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  return [...files]
    .filter(
      file =>
        !file.startsWith('components/weflow-cli/') &&
        !file.startsWith('packages/voice-codec/') &&
        fs.statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile(),
    )
    .sort();
}
