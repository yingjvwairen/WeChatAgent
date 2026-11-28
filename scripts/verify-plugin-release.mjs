import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { withReleaseSnapshot } from './release-snapshot.mjs';

const root = path.resolve(import.meta.dirname, '..'),
  hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
await withReleaseSnapshot(root, async ({ commit, directory: source, files, pluginHost }) => {
  const fromSnapshot = relative => import(pathToFileURL(path.join(source, relative)).href);
  const { assertPluginHost } = await fromSnapshot('scripts/plugin-host-check.mjs');
  const { BUNDLED_PLUGINS } = await fromSnapshot('packages/plugin-api/bundled.mjs');
  const { releaseIdentity } = await fromSnapshot('scripts/release-version.mjs');
  const { verifyReaderKey } = await fromSnapshot('scripts/prepare-reader-key.mjs');
  const { deploymentVerification, verifyInstallerDesktopApp, verifyInstallerOcrModel, verifyInstallerPayload } =
    await fromSnapshot('scripts/release-verification.mjs');
  const { installerRuntimeRevision, runtimeVersions, verifyInstallerRuntime } = await fromSnapshot(
    'scripts/prepare-installer-runtime.mjs',
  );
  const { version, packageVersion } = releaseIdentity(JSON.parse(fs.readFileSync(path.join(source, 'package.json'))));
  const { wechatVersion } = JSON.parse(fs.readFileSync(path.join(source, 'release-profile.json'), 'utf8'));
  const sourceReport = JSON.parse(fs.readFileSync(path.join(root, 'state/source-release-' + version + '.json')));
  const builtFiles = Object.keys(sourceReport.sourceFiles).sort();
  if (sourceReport.commit !== commit || JSON.stringify(builtFiles) !== JSON.stringify(files))
    throw Error('SOURCE_SNAPSHOT_CHANGED_AFTER_PACKAGING');
  for (const file of builtFiles)
    if (hash(fs.readFileSync(path.join(source, file))) !== sourceReport.sourceFiles[file])
      throw Error('SOURCE_CHANGED_AFTER_PACKAGING: ' + file);
  const stage = path.join(root, 'state/installer-stage/project'),
    unpacked = path.join(root, 'release/installer/win-unpacked/resources/project');
  const reports = [],
    builtinPlugins = BUNDLED_PLUGINS.filter(item => item.builtin === true).map(item => item.id);
  for (const directory of [stage, unpacked]) {
    verifyInstallerDesktopApp(path.join(directory, '../app'), source, { version, packageVersion }, root);
    await assertPluginHost(directory, { compareRoot: source });
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'deployment.json')));
    if (
      manifest.sourceCommit !== commit ||
      manifest.version !== version ||
      manifest.packageVersion !== packageVersion ||
      manifest.runtimeRevision !== installerRuntimeRevision ||
      manifest.node !== runtimeVersions.node ||
      manifest.python !== runtimeVersions.python ||
      manifest.desktopRuntime !== true ||
      manifest.wechatVersion !== wechatVersion ||
      manifest.bundledWechatVersions?.length !== 0
    )
      throw Error('INSTALLER_DESKTOP_MANIFEST_INVALID');
    if (JSON.stringify(manifest.builtinPlugins) !== JSON.stringify(builtinPlugins))
      throw Error('INSTALLER_BUILTIN_PLUGINS_MISMATCH');
    for (const file of manifest.files)
      if (hash(fs.readFileSync(path.join(directory, file))) !== manifest.sourceHashes[file])
        throw Error('INSTALLER_FILE_CHANGED: ' + file);
    const packagedFiles = new Set(manifest.files);
    for (const file of builtFiles)
      if (!packagedFiles.has(file) || manifest.sourceHashes[file] !== sourceReport.sourceFiles[file])
        throw Error('INSTALLER_SOURCE_CLOSURE_MISMATCH: ' + file);
    for (const [file, expected] of Object.entries(manifest.nativeHashes))
      if (hash(fs.readFileSync(path.join(directory, '../desktop-native', file))) !== expected)
        throw Error('INSTALLER_NATIVE_CHANGED: ' + file);
    if (!verifyReaderKey(fs.readFileSync(path.join(directory, '../runtime/reader-key/wx_key.dll'))))
      throw Error('INSTALLER_READER_SETUP_CHANGED');
    verifyInstallerRuntime(path.join(directory, '../runtime'));
    await verifyInstallerOcrModel(path.dirname(directory));
    for (const [runtime, imports] of [
      ['python', 'import sqlcipher3,av,psutil,win32api,win32gui,win32process'],
      ['ocr', 'import rapidocr,onnxruntime,numpy,PIL'],
    ]) {
      const probe = spawnSync(path.join(directory, '../runtime', runtime, 'python.exe'), ['-B', '-c', imports], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 60000,
      });
      if (probe.status !== 0) throw Error('INSTALLER_RUNTIME_IMPORT_FAILED: ' + runtime);
    }
    if (
      fs.existsSync(path.join(directory, '../vendor/wechat')) ||
      fs.existsSync(path.join(directory, '../vendor/hook'))
    )
      throw Error('INSTALLER_RETIRED_VENDOR_INCLUDED');
    reports.push(deploymentVerification(manifest));
  }
  if (JSON.stringify(reports[0]) !== JSON.stringify(reports[1])) throw Error('INSTALLER_STAGES_DIVERGED');
  const installerRelative = 'release/installer/WeChatAgent-Setup-' + version + '-x64.exe',
    installer = fs.readFileSync(path.join(root, installerRelative));
  const pe = installer.readUInt32LE(0x3c);
  if (installer.toString('ascii', 0, 2) !== 'MZ' || installer.readUInt32LE(pe) !== 0x4550)
    throw Error('INSTALLER_PE_INVALID');
  await verifyInstallerPayload(path.join(root, installerRelative), path.resolve(unpacked, '../..'), root);
  const assets = [
    installerRelative,
    sourceReport.asset.path,
    ...BUNDLED_PLUGINS.filter(item => item.zip).map(item => item.zip),
  ];
  const assetRecords = assets.map(relative => {
    const bytes = fs.readFileSync(path.join(root, relative));
    return { path: relative, bytes: bytes.length, sha256: hash(bytes) };
  });
  for (const asset of assetRecords)
    if (sourceReport.sourceFiles[asset.path] && sourceReport.sourceFiles[asset.path] !== asset.sha256)
      throw Error('PLUGIN_RELEASE_ASSET_CHANGED');
  if (assetRecords[0].sha256 !== hash(installer)) throw Error('INSTALLER_CHANGED_DURING_VERIFICATION');
  if (assetRecords.find(item => item.path === sourceReport.asset.path).sha256 !== sourceReport.asset.sha256)
    throw Error('SOURCE_ARCHIVE_CHANGED');
  const report = {
    version,
    packageVersion,
    ok: true,
    ...reports[0],
    checkedAt: new Date().toISOString(),
    sourceCommit: commit,
    pluginHost,
    sourcePrivacy: { candidateFiles: files.length, findings: [] },
    templateFilesVerified: reports,
    desktopRuntime: true,
    wechatVersion,
    bundledWechatVersions: [],
    sourceFiles: sourceReport.sourceFiles,
    assets: assetRecords,
    builtinPlugins,
    pluginAutoInstalled: true,
    pluginAutoEnabled: false,
    publication: 'local-build-only',
    validationLimits: [
      'Artifact, source closure, plugin contract, bundled OCR model and runtime imports only; this command does not operate WeChat or claim live/second-machine acceptance.',
    ],
  };
  const release = path.join(root, 'release/installer');
  for (const file of ['VERIFICATION.json', 'VERIFICATION-' + version + '.json'])
    fs.writeFileSync(path.join(release, file), JSON.stringify(report, null, 2) + '\n');
  if (new Set(assetRecords.map(item => path.basename(item.path))).size !== assetRecords.length)
    throw Error('RELEASE_ASSET_NAME_CONFLICT');
  fs.writeFileSync(
    path.join(release, 'SHA256SUMS.txt'),
    assetRecords.map(item => item.sha256 + '  ' + path.basename(item.path)).join('\n') + '\n',
  );
  fs.writeFileSync(
    path.join(root, installerRelative + '.sha256'),
    assetRecords[0].sha256 + '  ' + path.basename(installerRelative) + '\n',
  );
  console.log(
    JSON.stringify({
      ok: true,
      version,
      buildId: report.buildId,
      sourceFiles: builtFiles.length,
      assets: assetRecords.length,
      pluginContract: pluginHost.revision,
    }),
  );
});
