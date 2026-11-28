import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const READER_KEY = Object.freeze({
  version: 1,
  bytes: 195072,
  sha256: '9a2f2c6a09a3219afa4748a5e7e513d99c607173c3112c5afcc888996b98248c',
  source:
    'https://raw.githubusercontent.com/zhuobichen/weflow-cli/3d56da9b91ab46f610ca811029e5782c528a58ec/resources/key/win32/x64/wx_key.dll',
});
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export function verifyReaderKey(bytes, artifact = READER_KEY) {
  return bytes.length === artifact.bytes && hash(bytes) === artifact.sha256;
}

/** Prepare the existing Reader setup dependency. This never loads the DLL. */
export async function prepareReaderKey({
  root,
  sourceFile,
  download = false,
  fetchImpl = fetch,
  artifact = READER_KEY,
} = {}) {
  if (!path.isAbsolute(root ?? '')) throw Error('READER_KEY_ROOT_INVALID');
  const file = path.join(root, 'components/weflow-cli/resources/key/win32/x64/wx_key.dll');
  if (fs.existsSync(file) && verifyReaderKey(fs.readFileSync(file), artifact))
    return { ready: true, sha256: artifact.sha256, file };
  let bytes;
  if (sourceFile) bytes = fs.readFileSync(sourceFile);
  else if (download) {
    const response = await fetchImpl(artifact.source, { signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!response.ok) throw Error('READER_KEY_DOWNLOAD_FAILED');
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > artifact.bytes) throw Error('READER_KEY_CHECKSUM_MISMATCH');
      chunks.push(Buffer.from(chunk));
    }
    bytes = Buffer.concat(chunks);
  } else throw Error('READER_KEY_COMPONENT_MISSING');
  if (!verifyReaderKey(bytes, artifact)) throw Error('READER_KEY_CHECKSUM_MISMATCH');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return { ready: true, sha256: artifact.sha256, file };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    at = args.indexOf('--source');
  if (
    args.some(
      (arg, index) => arg !== '--download' && arg !== '--check' && arg !== '--source' && !(at >= 0 && index === at + 1),
    ) ||
    (at >= 0 && !args[at + 1])
  )
    throw Error('READER_KEY_ARGUMENTS_INVALID');
  const result = await prepareReaderKey({
    root: path.resolve(import.meta.dirname, '..'),
    sourceFile: at >= 0 ? args[at + 1] : undefined,
    download: args.includes('--download'),
  });
  console.log(JSON.stringify({ ready: result.ready, sha256: result.sha256 }));
}
