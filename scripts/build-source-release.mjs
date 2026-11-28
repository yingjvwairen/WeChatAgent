import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { releaseIdentity } from './release-version.mjs';
import { withReleaseSnapshot } from './release-snapshot.mjs';

const workspace = path.resolve(import.meta.dirname, '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
await withReleaseSnapshot(workspace, ({ directory, archive, files, commit, pluginHost }) => {
  const { version, packageVersion } = releaseIdentity(
    JSON.parse(fs.readFileSync(path.join(directory, 'package.json'))),
  );
  const output = path.join(workspace, 'release/installer/WeChatAgent-' + version + '-source.zip');
  const bytes = fs.readFileSync(archive),
    sha256 = hash(bytes);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, bytes);
  fs.writeFileSync(output + '.sha256', sha256 + '  ' + path.basename(output) + '\n');
  const report = {
    version,
    packageVersion,
    commit,
    ok: true,
    sourceOnly: true,
    pluginHost,
    files: files.length,
    sourceFiles: Object.fromEntries(files.map(file => [file, hash(fs.readFileSync(path.join(directory, file)))])),
    asset: { path: path.relative(workspace, output).replaceAll(path.sep, '/'), bytes: bytes.length, sha256 },
  };
  fs.mkdirSync(path.join(workspace, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, 'state/source-release-' + version + '.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify({ ok: true, files: files.length, commit, bytes: bytes.length, sha256, output }));
});
