import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { LOCAL_OCR_MODEL, verifyOcrModel } from './desktop-sender/prepare-local-ocr-model.mjs';

export const DESKTOP_APP_SOURCE_FILES = Object.freeze([
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
]);

export function desktopInstallerPackage({ name, appId, productName, dependencies }, { version, packageVersion }) {
  return {
    name,
    appId,
    productName,
    version: packageVersion,
    releaseVersion: version,
    description: 'WeChatAgent desktop console',
    main: 'main.cjs',
    author: 'WeChatAgent contributors',
    license: 'SEE THIRD-PARTY-NOTICES.txt',
    dependencies,
  };
}

const yamlRuntimePath = 'node_modules/yaml';

function desktopYamlManifest(file) {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Electron Builder strips npm scripts and keywords from installed dependency manifests.
  delete manifest.scripts;
  delete manifest.keywords;
  return manifest;
}

function desktopYamlRuntime(workspace, expectedVersion) {
  const from = path.join(workspace, yamlRuntimePath);
  const manifest = desktopYamlManifest(path.join(from, 'package.json'));
  if (manifest.name !== 'yaml' || manifest.version !== expectedVersion)
    throw Error('Installed YAML parser must match the desktop package version. Run npm ci.');
  const files = payloadFiles(path.join(from, 'dist'))
    .filter(file => file.endsWith('.js'))
    .map(file => path.join('dist', file));
  return { from, files: ['LICENSE', ...files], manifest };
}

export function stageDesktopYaml(app, workspace, version) {
  const { from, files } = desktopYamlRuntime(workspace, version);
  for (const file of ['package.json', ...files]) {
    const destination = path.join(app, yamlRuntimePath, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(from, file), destination);
  }
}

export function verifyInstallerDesktopApp(app, source, release, workspace = source) {
  const desktop = path.join(source, 'apps/console-desktop');
  for (const name of DESKTOP_APP_SOURCE_FILES) {
    const audited = fs.readFileSync(path.join(desktop, name));
    if (!audited.equals(fs.readFileSync(path.join(app, name)))) throw Error('INSTALLER_DESKTOP_APP_CHANGED: ' + name);
  }
  const sourcePackage = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
  const expected = desktopInstallerPackage(sourcePackage, release);
  const installed = fs.readFileSync(path.join(app, 'package.json'), 'utf8');
  if (installed !== JSON.stringify(expected, null, 2)) throw Error('INSTALLER_DESKTOP_PACKAGE_CHANGED');
  if (sourcePackage.dependencies?.yaml) {
    const { from, files, manifest } = desktopYamlRuntime(workspace, sourcePackage.dependencies.yaml);
    const parserPackage = path.join(app, yamlRuntimePath, 'package.json');
    if (
      !fs.existsSync(parserPackage) ||
      JSON.stringify(desktopYamlManifest(parserPackage)) !== JSON.stringify(manifest)
    )
      throw Error('INSTALLER_DESKTOP_YAML_CHANGED: package.json');
    for (const file of files) {
      const actual = path.join(app, yamlRuntimePath, file);
      if (!fs.existsSync(actual) || !fs.readFileSync(actual).equals(fs.readFileSync(path.join(from, file))))
        throw Error('INSTALLER_DESKTOP_YAML_CHANGED: ' + file);
    }
  }
}

export async function verifyInstallerOcrModel(resources) {
  const model = path.join(resources, 'runtime', 'ocr-models', LOCAL_OCR_MODEL.file);
  if (!(await verifyOcrModel(model))) throw Error('INSTALLER_OCR_MODEL_INVALID: ' + LOCAL_OCR_MODEL.file);
}

function payloadFiles(root) {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => !entry.isDirectory())
    .map(entry => {
      if (!entry.isFile()) throw Error('INSTALLER_SPECIAL_FILE');
      return path.relative(root, path.join(entry.parentPath, entry.name));
    })
    .sort();
}

async function fileDigest(file) {
  const digest = crypto.createHash('sha256');
  for await (const block of fs.createReadStream(file)) digest.update(block);
  return digest.digest('hex');
}

export async function verifyInstallerPayload(installer, unpacked, workspace) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-installer-check-'));
  try {
    // electron-builder stores the x64 application as a 7z archive inside the NSIS executable.
    const { path7za } = createRequire(path.join(workspace, 'package.json'))('7zip-bin');
    execFileSync(path7za, ['x', '-t7z', '-y', '-bd', '-o' + directory, installer], {
      windowsHide: true,
      stdio: 'pipe',
      timeout: 300000,
    });
    const expected = payloadFiles(unpacked);
    if (JSON.stringify(payloadFiles(directory)) !== JSON.stringify(expected))
      throw Error('INSTALLER_PAYLOAD_FILE_SET_CHANGED');
    for (const relative of expected) {
      const [actual, wanted] = await Promise.all(
        [directory, unpacked].map(base => fileDigest(path.join(base, relative))),
      );
      if (actual !== wanted) throw Error('INSTALLER_PAYLOAD_MISMATCH: ' + relative);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

// Preserve the producer's build identity for the console's update comparison.
// checkedAt describes verification time; it must not substitute for builtAt.
export function deploymentVerification(manifest) {
  if (
    !/^[a-f0-9]{16}$/.test(manifest.buildId ?? '') ||
    !Number.isFinite(Date.parse(manifest.builtAt)) ||
    !/^[a-f0-9]{12}$/.test(manifest.runtimeRevision ?? '') ||
    !Array.isArray(manifest.files)
  )
    throw Error('INSTALLER_BUILD_IDENTITY_INVALID');
  return {
    buildId: manifest.buildId,
    builtAt: manifest.builtAt,
    runtimeRevision: manifest.runtimeRevision,
    files: manifest.files.length,
    nativeHashes: manifest.nativeHashes,
  };
}
