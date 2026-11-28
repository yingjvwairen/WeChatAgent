import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { DSH_SDK_VERSION, DSH_INSTALL_URL } from '../public/console/dsh-install.mjs';
import { spawnSync } from 'node:child_process';
import { buildIcons, embedExecutableIcon } from './build-icons.mjs';
import { singleDirectoryTemplate } from './installer-directory-page.mjs';
import { assertPluginHost } from './plugin-host-check.mjs';
import { BUNDLED_PLUGINS } from '../packages/plugin-api/bundled.mjs';
import { releaseIdentity } from './release-version.mjs';
import { READER_KEY, verifyReaderKey } from './prepare-reader-key.mjs';

export async function packageInstaller(workspace, { directory: root, files: sourceFiles, commit }, stageOnly) {
  const wechatVersion = '4.2.0.53';
  const { version, packageVersion, buildVersion } = releaseIdentity(
    JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')),
  );
  const stage = path.join(workspace, 'state', 'installer-stage');
  const appDir = path.join(stage, 'app');
  const project = path.join(stage, 'project');
  const vendor = path.join(stage, 'vendor');
  const bundledPython = path.join(stage, 'runtime/python/python.exe');
  const inputProbe = spawnSync(
    bundledPython,
    ['-B', '-c', 'import psutil,win32api,win32clipboard,win32gui,win32process'],
    { windowsHide: true, encoding: 'utf8', timeout: 30000 },
  );
  if (inputProbe.status !== 0)
    throw new Error(
      'Bundled foreground input dependencies are unavailable. Run prepare-installer-runtime.mjs first. ' +
        (inputProbe.stderr || ''),
    );
  if (!verifyReaderKey(fs.readFileSync(path.join(stage, 'runtime/reader-key/wx_key.dll'))))
    throw Error('READER_KEY_CHECKSUM_MISMATCH');
  const require = createRequire(path.join(workspace, 'package.json'));
  const pluginPackage = JSON.parse(
    fs.readFileSync(path.join(root, 'packages/dsh-social-bridge-plugin/package.json'), 'utf8'),
  );
  const sdkPackage = JSON.parse(
    fs.readFileSync(
      path.join(workspace, 'packages/dsh-social-bridge-plugin/node_modules/@deepseek-ai/dsh-llm/package.json'),
      'utf8',
    ),
  );
  if (pluginPackage.dependencies['@deepseek-ai/dsh-llm'] !== DSH_SDK_VERSION || sdkPackage.version !== DSH_SDK_VERSION)
    throw new Error('Installed plugin SDK must match the declared DSH compatibility version.');
  console.log('DSH desktop is external; only the bridge plugin and SDK ' + DSH_SDK_VERSION + ' are included.');
  const nativeStage = path.join(stage, 'desktop-native');
  for (const dir of [appDir, project, vendor, nativeStage]) {
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(path.resolve(stage) + path.sep)) throw new Error('Invalid release staging directory');
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  for (const dir of [appDir, project, vendor, path.join(stage, 'runtime')]) fs.mkdirSync(dir, { recursive: true });
  const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const files = [];
  function copyFile(source, target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  function copyTree(source, target, allow = () => true) {
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (!allow(entry.name, entry.isDirectory()) || entry.isSymbolicLink()) continue;
      const from = path.join(source, entry.name),
        to = path.join(target, entry.name);
      if (entry.isDirectory()) copyTree(from, to, allow);
      else copyFile(from, to);
    }
  }
  function add(relative) {
    copyFile(path.join(root, relative), path.join(project, relative));
    files.push(relative);
  }
  function addTree(relative, allow) {
    copyTree(path.join(workspace, relative), path.join(project, relative), allow);
    for (const name of fs.readdirSync(path.join(project, relative), { recursive: true }))
      if (fs.statSync(path.join(project, relative, name)).isFile())
        files.push((relative + '/' + name).replaceAll('\\', '/'));
  }

  for (const name of [
    'package.json',
    'main.cjs',
    'preload.cjs',
    'shutdown.cjs',
    'storage-location.cjs',
    'desktop-policy.cjs',
    'deployment.cjs',
    'appearance.cjs',
    'loading-preload.cjs',
    'loading.html',
    'loading.css',
    'loading.js',
  ])
    copyFile(path.join(root, 'apps/console-desktop', name), path.join(appDir, name));
  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify(
      {
        name: 'wechatagent',
        productName: 'WeChatAgent',
        version: packageVersion,
        releaseVersion: version,
        description: 'WeChatAgent desktop console',
        main: 'main.cjs',
        author: 'WeChatAgent contributors',
        license: 'SEE THIRD-PARTY-NOTICES.txt',
      },
      null,
      2,
    ),
  );
  await buildIcons(root, appDir, require('sharp'));
  for (const relative of sourceFiles) add(relative);
  const presetNames = fs
    .readdirSync(path.join(root, 'roles'))
    .filter(name => name.endsWith('.md') && name !== 'README.md');
  // The source checker owns the source closure; production SDK dependencies are
  // the only additional project files in an installed runtime.
  addTree('packages/dsh-social-bridge-plugin/node_modules', name => name !== '.bin' && name !== '.cache');
  const builtinPlugins = BUNDLED_PLUGINS.filter(bundle => bundle.builtin === true).map(bundle => bundle.id);
  await assertPluginHost(project, { compareRoot: root });

  const nativeBuild = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(root, 'scripts/desktop-sender/build-native.ps1'),
      '-SelfTest',
      '-OutputDirectory',
      nativeStage,
    ],
    { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 },
  );
  if (nativeBuild.status !== 0)
    throw Error('DESKTOP_NATIVE_BUILD_FAILED: ' + (nativeBuild.stderr || nativeBuild.stdout));
  const accessibilityBuild = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(root, 'scripts/build-accessibility-gate-42053.ps1'),
      '-SelfTest',
      '-OutputDirectory',
      nativeStage,
    ],
    { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 },
  );
  if (accessibilityBuild.status !== 0) throw Error('DESKTOP_ACCESSIBILITY_BUILD_FAILED');
  const nativeHashes = Object.fromEntries(
    fs
      .readdirSync(nativeStage)
      .filter(name => name.endsWith('.exe'))
      .sort()
      .map(name => [name, sha(fs.readFileSync(path.join(nativeStage, name)))]),
  );
  copyFile(process.execPath, path.join(stage, 'runtime/node.exe'));
  if (!fs.existsSync(path.join(stage, 'runtime/python/python.exe')))
    throw new Error('Run prepare-installer-runtime.mjs first.');
  const fileList = [...new Set(files)].sort();
  const sourceHashes = Object.fromEntries(fileList.map(file => [file, sha(fs.readFileSync(path.join(project, file)))]));
  const desktopHashes = Object.fromEntries(
    fs
      .readdirSync(appDir)
      .filter(file => fs.statSync(path.join(appDir, file)).isFile())
      .sort()
      .map(file => [file, sha(fs.readFileSync(path.join(appDir, file)))]),
  );
  const runtimeRevision = sha(
    Buffer.from(
      JSON.stringify({
        node: sha(fs.readFileSync(process.execPath)),
        python: fs.readFileSync(path.join(stage, 'runtime/python/DEPENDENCIES.json'), 'utf8'),
        ocr: fs.readFileSync(path.join(stage, 'runtime/ocr/DEPENDENCIES.json'), 'utf8'),
      }),
    ),
  ).slice(0, 12);
  const buildId = sha(
    Buffer.from(
      JSON.stringify({
        sourceHashes,
        desktopHashes,
        builtinPlugins,
        runtimeRevision,
        desktopRuntime: true,
        wechatVersion,
        nativeHashes,
      }),
    ),
  ).slice(0, 16);
  fs.writeFileSync(
    path.join(project, 'deployment.json'),
    JSON.stringify(
      {
        version,
        packageVersion,
        buildId,
        sourceCommit: commit,
        builtAt: new Date().toISOString(),
        runtimeRevision,
        desktopRuntime: true,
        nativeHashes,
        readerKey: { bytes: READER_KEY.bytes, sha256: READER_KEY.sha256 },
        wechatVersion,
        bundledWechatVersions: [],
        sourceHashes,
        files: fileList,
        builtinPlugins,
        presets: presetNames.map(name => name.slice(0, -3)),
        node: process.version,
        python: '3.13.16',
        dshBundled: false,
        dshSdkVersion: DSH_SDK_VERSION,
        dshInstallUrl: DSH_INSTALL_URL,
        privateAccountDataIncluded: false,
        clientDistribution: 'Uses the user-installed WeChat 4.2.0.53; no WeChat client or sender Hook is bundled.',
      },
      null,
      2,
    ),
  );
  // No personal data can enter the deployment template or vendor programs.
  for (const file of fs.readdirSync(project, { recursive: true })) {
    const relative = String(file).replaceAll('\\', '/');
    if (/^state\/|(^|\/)wechatagent\.json$|social-dsh-token|native-token|\.env$|WeFlow-config\.json$/.test(relative))
      throw new Error('Private file entered the release: ' + relative);
  }
  for (const file of fs.readdirSync(vendor, { recursive: true }))
    if (
      /wechatagent-hook\.token|native-token|social-messages|WeFlow-config\.json|^.*\/\.dsh\//.test(
        String(file).replaceAll('\\', '/'),
      )
    )
      throw new Error('Private vendor file entered the release: ' + file);
  const notices =
    'WeChatAgent ' +
    version +
    '\n\nWeChat and DSH are installed separately by the user. No WeChat client or memory-injection sending component is bundled.\n\nBundled components: Electron, Node.js, Python 3.13.16, SQLCipher Python binding, cryptography, zstandard, pycryptodome, Pillow, imageio-ffmpeg, cffi, pycparser, psutil, pywin32, RapidOCR, ONNX Runtime, NumPy, MIT weflow-cli NT reader sources, MIT Social Bridge sources and the local DSH bridge plugin/SDK. The DSH desktop program is installed separately by the user.\n\nPython and wheel licenses are retained in runtime/python, runtime/ocr and their site-packages/*.dist-info directories. Electron/Chromium and vendor notices are retained with their programs. Refer to project/LICENSES.md for source attribution and license boundaries. No account, credential, chat or whitelist data is included. Maintainer-authorized persona files are included as presets.\n';
  fs.writeFileSync(path.join(appDir, 'THIRD-PARTY-NOTICES.txt'), notices);
  copyFile(path.join(root, 'LICENSE'), path.join(appDir, 'LICENSE.txt'));
  if (stageOnly) {
    console.log('Installer source/runtime stage verified.');
    return;
  }
  const { build, Platform, Arch } = require('electron-builder');
  const templateDir = path.dirname(require.resolve('app-builder-lib/package.json')) + '/templates/nsis';
  const customNsis = path.join(stage, 'nsis-templates');
  fs.mkdirSync(customNsis, { recursive: true });
  copyTree(templateDir, customNsis);
  let multiUser = fs.readFileSync(path.join(templateDir, 'multiUser.nsh'), 'utf8');
  const originalFolderLookup = /      System::Store S[\s\S]*?      System::Store L\r?\n/;
  if (!originalFolderLookup.test(multiUser))
    throw new Error('NSIS per-user path template differs; inspect before building.');
  multiUser = multiUser.replace(
    originalFolderLookup,
    '      # Current-user LocalAppData avoids the old System::Store memory fault.\n',
  );
  fs.writeFileSync(path.join(customNsis, 'multiUser.nsh'), multiUser);
  const assistedFile = path.join(customNsis, 'assistedInstaller.nsh');
  const assisted = fs.readFileSync(assistedFile, 'utf8');
  fs.writeFileSync(assistedFile, singleDirectoryTemplate(assisted));
  // User data is outside the install directory and deleteAppDataOnUninstall is
  // false. Standard removal avoids the legacy uninstaller's atomic rename,
  // which fails across drives and on long bundled LibreOffice file paths.
  const installUtilFile = path.join(customNsis, 'include/installUtil.nsh');
  let installUtil = fs.readFileSync(installUtilFile, 'utf8');
  const updatedArgument = '    StrCpy $0 "$0 --updated"';
  if (!installUtil.includes(updatedArgument)) throw new Error('NSIS update template differs; inspect before building.');
  installUtil = installUtil.replace(
    updatedArgument,
    '    # Keep AppData and use standard removal for large vendor runtimes.',
  );
  fs.writeFileSync(installUtilFile, installUtil);
  const uninstallFile = path.join(customNsis, 'uninstaller.nsh');
  let uninstall = fs.readFileSync(uninstallFile, 'utf8');
  if (!uninstall.includes('    RMDir /r $INSTDIR'))
    throw new Error('NSIS removal template differs; inspect before building.');
  uninstall = uninstall.replace(
    '    RMDir /r $INSTDIR',
    '    RMDir /r $INSTDIR\n    # Remove paths beyond MAX_PATH after ordinary files.\n    RMDir /r "\\\\?\\$INSTDIR"',
  );
  fs.writeFileSync(uninstallFile, uninstall);
  // Redirect this build's templates without modifying installed builder files;
  // keep its standard installer/uninstaller generation and relative includes.
  require('app-builder-lib/out/targets/nsis/nsisUtil').nsisTemplatesDir = customNsis;
  process.env.ELECTRON_BUILDER_CACHE = path.join(workspace, 'state', 'installer-cache', 'electron-builder');
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL ??= '1';
  await build({
    targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
    config: {
      appId: 'local.wechatagent.desktop',
      productName: 'WeChatAgent',
      artifactName: 'WeChatAgent-Setup-' + version + '-${arch}.${ext}',
      buildVersion,
      directories: { app: appDir, output: path.join(workspace, 'release', 'installer'), buildResources: appDir },
      electronDist: path.join(workspace, 'node_modules/electron/dist'),
      electronVersion: '41.1.1',
      asar: false,
      npmRebuild: false,
      buildDependenciesFromSource: false,
      files: ['**/*'],
      afterPack: async context =>
        embedExecutableIcon(
          path.join(context.appOutDir, 'WeChatAgent.exe'),
          path.join(appDir, 'icon.ico'),
          require('resedit'),
        ),
      extraResources: [
        { from: project, to: 'project' },
        { from: path.join(stage, 'runtime'), to: 'runtime', filter: ['**/*', '!**/__pycache__/**', '!**/*.pyc'] },
        { from: path.join(stage, 'desktop-native'), to: 'desktop-native' },
      ],
      win: {
        target: ['nsis'],
        icon: path.join(appDir, 'icon.ico'),
        signAndEditExecutable: false,
        requestedExecutionLevel: 'asInvoker',
      },
      nsis: {
        include: path.join(root, 'apps/console-desktop/installer-storage.nsh'),
        installerIcon: path.join(appDir, 'icon.ico'),
        uninstallerIcon: path.join(appDir, 'icon.ico'),
        oneClick: false,
        perMachine: false,
        allowElevation: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        deleteAppDataOnUninstall: false,
        differentialPackage: false,
        runAfterFinish: false,
        installerLanguages: ['zh_CN', 'en_US'],
        language: '2052',
        license: path.join(appDir, 'LICENSE.txt'),
      },
      compression: 'normal',
      publish: null,
    },
  });
  console.log('Installer built in release/installer');
}
