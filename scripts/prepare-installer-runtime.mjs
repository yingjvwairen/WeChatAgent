import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { projectRoot } from './project-config.mjs';
import { prepareLocalOcrModel, LOCAL_OCR_MODEL } from './desktop-sender/prepare-local-ocr-model.mjs';
import { prepareReaderKey } from './prepare-reader-key.mjs';

const cache = path.join(projectRoot, 'state/installer-cache'),
  runtimeRoot = path.join(projectRoot, 'state/installer-stage/runtime');
const buildPython = process.env.WECHATAGENT_BUILD_PYTHON || 'python';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
fs.mkdirSync(cache, { recursive: true });
fs.mkdirSync(runtimeRoot, { recursive: true });
async function download(url, file, sha) {
  if (fs.existsSync(file) && hash(fs.readFileSync(file)) === sha) return;
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw Error('Dependency download failed: ' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (hash(bytes) !== sha) throw Error('Dependency checksum mismatch');
  fs.writeFileSync(file, bytes);
}
function unpack(file, target) {
  const require = createRequire(path.join(projectRoot, 'package.json'));
  const result = spawnSync(require('7zip-bin').path7za, ['x', file, '-o' + target, '-y'], {
    windowsHide: true,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw Error('Dependency archive extraction failed');
}
const archive = path.join(cache, 'python-3.13.16-embed-amd64.zip');
const readerKey = await prepareReaderKey({
  root: projectRoot,
  sourceFile: process.env.WECHATAGENT_READER_KEY_SOURCE,
  download: true,
});
fs.mkdirSync(path.join(runtimeRoot, 'reader-key'), { recursive: true });
fs.copyFileSync(readerKey.file, path.join(runtimeRoot, 'reader-key/wx_key.dll'));
await download(
  'https://www.python.org/ftp/python/3.13.16/python-3.13.16-embed-amd64.zip',
  archive,
  '97dae5274cc54867065e8d5a3226e48c35017ed332a0fdb0e27d5b5821961297',
);
async function buildRuntime(kind, requirements, imports) {
  const runtime = path.join(runtimeRoot, kind),
    wheels = path.join(cache, 'wheels-' + kind);
  for (const target of [runtime, wheels]) {
    if (!path.resolve(target).startsWith(path.resolve(projectRoot, 'state') + path.sep))
      throw Error('Invalid runtime staging path');
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
  }
  // Resolve the complete wheel closure for the shipped interpreter, including
  // transitive dependencies. Pip is only a build tool; it is not shipped.
  const args = [
    '-I',
    '-m',
    'pip',
    '--isolated',
    'download',
    '--only-binary=:all:',
    '--python-version',
    '313',
    '--implementation',
    'cp',
    '--abi',
    'cp313',
    '--platform',
    'win_amd64',
    '--index-url',
    'https://pypi.org/simple',
    '--dest',
    wheels,
    ...requirements.flatMap(file => ['-r', path.join(projectRoot, file)]),
  ];
  const resolved = spawnSync(buildPython, args, {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (resolved.status !== 0)
    throw Error('Wheel resolution failed for ' + kind + ': ' + (resolved.stderr || resolved.stdout));
  unpack(archive, runtime);
  const site = path.join(runtime, 'Lib/site-packages');
  fs.mkdirSync(site, { recursive: true });
  const locked = [];
  for (const name of fs.readdirSync(wheels).sort()) {
    if (!name.endsWith('.whl')) throw Error('Only binary wheels are allowed');
    const [project, version] = name.split('-');
    const response = await fetch(`https://pypi.org/pypi/${project}/${version}/json`, {
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw Error('Dependency metadata unavailable: ' + project);
    const metadata = await response.json(),
      wheel = metadata.urls.find(item => item.filename === name);
    const file = path.join(wheels, name),
      sha256 = hash(fs.readFileSync(file));
    if (!wheel || wheel.digests.sha256 !== sha256) throw Error('Resolved wheel checksum mismatch: ' + name);
    unpack(file, site);
    for (const entry of fs.readdirSync(site).filter(item => item.endsWith('.data'))) {
      const data = path.join(site, entry);
      for (const library of ['purelib', 'platlib'])
        if (fs.existsSync(path.join(data, library))) fs.cpSync(path.join(data, library), site, { recursive: true });
    }
    locked.push({ name: project, version, filename: name, sha256, url: wheel.url });
  }
  fs.writeFileSync(path.join(runtime, 'python313._pth'), 'python313.zip\n.\nLib/site-packages\nimport site\n');
  fs.writeFileSync(path.join(runtime, 'DEPENDENCIES.json'), JSON.stringify(locked, null, 2));
  const checked = spawnSync(path.join(runtime, 'python.exe'), ['-B', '-c', imports], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 60000,
  });
  if (checked.status !== 0) throw Error('Bundled ' + kind + ' runtime probe failed: ' + checked.stderr);
  console.log(kind + ' runtime: ' + locked.length + ' verified wheels');
}
await buildRuntime(
  'python',
  ['scripts/reader-requirements.txt', 'scripts/desktop-requirements.txt'],
  'import sqlcipher3,cryptography,zstandard,Crypto,PIL,imageio_ffmpeg,av,psutil,win32api,win32clipboard,win32gui,win32process; from sqlcipher3 import dbapi2; dbapi2.connect(":memory:").execute("select 1").fetchone()',
);
await buildRuntime('ocr', ['scripts/desktop-sender/requirements-ocr.txt'], 'import rapidocr,onnxruntime,numpy,PIL');
await prepareLocalOcrModel({ projectRoot, download: true });
const modelStage = path.join(runtimeRoot, 'ocr-models');
fs.mkdirSync(modelStage, { recursive: true });
fs.copyFileSync(
  path.join(projectRoot, 'state/ocr/models', LOCAL_OCR_MODEL.file),
  path.join(modelStage, LOCAL_OCR_MODEL.file),
);
console.log('Reader/desktop and OCR runtimes prepared; no WeChat or DSH distribution copied.');
