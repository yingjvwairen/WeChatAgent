import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import lock from './installer-runtime-lock.json' with { type: 'json' };
import { prepareLocalOcrModel, LOCAL_OCR_MODEL } from './desktop-sender/prepare-local-ocr-model.mjs';
import { prepareReaderKey } from './prepare-reader-key.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const matches = (file, sha256) => fs.existsSync(file) && hash(fs.readFileSync(file)) === sha256;
export const runtimeVersions = { node: 'v' + lock.node.version, python: lock.python.version };
export const installerRuntimeRevision = hash(JSON.stringify(lock)).slice(0, 12);
const imports = {
  python:
    'import sqlcipher3,cryptography,zstandard,Crypto,PIL,imageio_ffmpeg,av,psutil,win32api,win32clipboard,win32gui,win32process; from sqlcipher3 import dbapi2; dbapi2.connect(":memory:").execute("select 1").fetchone()',
  ocr: 'import rapidocr,onnxruntime,numpy,PIL',
};

async function download(url, file, sha256, fetchImpl = fetch) {
  if (matches(file, sha256)) return file;
  const name = path.basename(file);
  let bytes;
  for (let attempt = 1; ; attempt++) {
    let response, cause;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(180000), redirect: 'error' });
      if (response.ok) {
        bytes = Buffer.from(await response.arrayBuffer());
        break;
      }
      await response.body?.cancel();
    } catch (error) {
      cause = error;
    }
    const reason = cause ? (cause.cause?.code ?? cause.name) : 'HTTP ' + response.status;
    const retry = cause
      ? cause instanceof TypeError || ['TimeoutError', 'AbortError'].includes(cause.name)
      : [408, 429].includes(response.status) || response.status >= 500;
    const message = `Dependency download failed for ${name} (${reason})`;
    if (!retry || attempt === 3) throw Error(message, { cause });
    console.warn(`${message}. Retrying (${attempt}/2).`);
    await delay(250 * attempt);
  }
  if (hash(bytes) !== sha256) throw Error('Dependency checksum mismatch: ' + name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(tmp, bytes, { flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return file;
}

export function prepareInstallerNode(workspace, { fetchImpl = fetch } = {}) {
  return download(
    lock.node.url,
    path.join(workspace, 'state/installer-cache', 'node-v' + lock.node.version + '-win-x64.exe'),
    lock.node.sha256,
    fetchImpl,
  );
}

export function verifyInstallerRuntime(runtime) {
  if (!matches(path.join(runtime, 'node.exe'), lock.node.sha256)) throw Error('INSTALLER_NODE_CHECKSUM_MISMATCH');
  for (const [kind, wheels] of Object.entries(lock.wheels))
    if (fs.readFileSync(path.join(runtime, kind, 'DEPENDENCIES.json'), 'utf8') !== JSON.stringify(wheels, null, 2))
      throw Error('INSTALLER_WHEEL_LOCK_MISMATCH: ' + kind);
}

/** Cache locked inputs by default. Only the packaging step expands them into an empty stage. */
export async function prepareInstallerRuntime(workspace, runtime) {
  const cache = path.join(workspace, 'state/installer-cache');
  const archiveName = 'python-' + lock.python.version + '-embed-amd64.zip';
  const node = await prepareInstallerNode(workspace);
  const archive = await download(
    'https://www.python.org/ftp/python/' + lock.python.version + '/' + archiveName,
    path.join(cache, archiveName),
    lock.python.sha256,
  );
  const archives = {};
  for (const [kind, wheels] of Object.entries(lock.wheels)) {
    archives[kind] = [];
    for (const wheel of wheels)
      archives[kind].push(await download(wheel.url, path.join(cache, 'wheels-' + kind, wheel.filename), wheel.sha256));
  }
  const readerKey = await prepareReaderKey({
    root: workspace,
    sourceFile: process.env.WECHATAGENT_READER_KEY_SOURCE,
    download: true,
  });
  await prepareLocalOcrModel({ projectRoot: workspace, download: true });
  if (!runtime) return;

  if (fs.readdirSync(runtime).length) throw Error('Installer runtime stage must be empty');
  const { path7za } = createRequire(path.join(workspace, 'package.json'))('7zip-bin');
  const unpack = (source, target) => {
    const result = spawnSync(path7za, ['x', source, '-o' + target, '-y'], { windowsHide: true, encoding: 'utf8' });
    if (result.status !== 0) throw Error('Dependency extraction failed: ' + path.basename(source));
  };
  const copy = (source, relative) => {
    const dest = path.join(runtime, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
  };
  copy(node, 'node.exe');
  copy(readerKey.file, 'reader-key/wx_key.dll');
  copy(path.join(workspace, 'state/ocr/models', LOCAL_OCR_MODEL.file), 'ocr-models/' + LOCAL_OCR_MODEL.file);

  for (const [kind, wheels] of Object.entries(lock.wheels)) {
    const directory = path.join(runtime, kind);
    unpack(archive, directory);
    const site = path.join(directory, 'Lib/site-packages');
    fs.mkdirSync(site, { recursive: true });
    for (const wheel of archives[kind]) {
      unpack(wheel, site);
      for (const entry of fs.readdirSync(site).filter(name => name.endsWith('.data'))) {
        const data = path.join(site, entry);
        for (const library of ['purelib', 'platlib'])
          if (fs.existsSync(path.join(data, library))) fs.cpSync(path.join(data, library), site, { recursive: true });
      }
    }
    const abi = lock.python.version.split('.').slice(0, 2).join('');
    fs.writeFileSync(
      path.join(directory, 'python' + abi + '._pth'),
      'python' + abi + '.zip\n.\nLib/site-packages\nimport site\n',
    );
    fs.writeFileSync(path.join(directory, 'DEPENDENCIES.json'), JSON.stringify(wheels, null, 2));
    const checked = spawnSync(path.join(directory, 'python.exe'), ['-B', '-c', imports[kind]], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 60000,
    });
    if (checked.status !== 0)
      throw Error('Bundled ' + kind + ' runtime probe failed: ' + (checked.stderr || checked.error));
    console.log(kind + ' runtime: ' + wheels.length + ' verified wheels');
  }
  verifyInstallerRuntime(runtime);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareInstallerRuntime(path.resolve(import.meta.dirname, '..'));
  console.log('Locked Windows runtime inputs are ready.');
}
