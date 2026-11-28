import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withReleaseSnapshot } from './release-snapshot.mjs';

const workspace = path.resolve(import.meta.dirname, '..');
await withReleaseSnapshot(workspace, async snapshot => {
  const builder = pathToFileURL(path.join(snapshot.directory, 'scripts/installer-package.mjs'));
  const { packageInstaller } = await import(builder.href);
  await packageInstaller(workspace, snapshot, process.argv.includes('--stage-only'));
});
