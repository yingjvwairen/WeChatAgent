import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPackage, json } from './catalog.mjs';
import { localSpeechPort } from './contract.mjs';

const pluginId = 'speech-synthesis';
const source = fileURLToPath(new URL('../../optional-extensions/speech-synthesis/', import.meta.url));
let bundledRevision;

// Only the exact reviewed package can receive service credentials. The
// workspace plugins directory also permits independently installed copies.
export function managedSpeechAvailable(record) {
  if (record.id !== pluginId || record.invalid) return false;
  try {
    bundledRevision ??= inspectPackage(source).revision;
    return record.revision === bundledRevision;
  } catch {
    return false;
  }
}

export function managedSpeechSettings(root, record) {
  if (!managedSpeechAvailable(record)) return {};
  let config;
  try {
    config = json(path.join(root, 'config/wechatagent.json')).runtime?.localSpeech;
  } catch {
    return {};
  }
  const managedSpeech = {};
  for (const [kind, capability, directory] of [
    ['asr', 'fileAsr', 'local-whisper'],
    ['tts', 'tts', 'local-gpt-sovits'],
  ]) {
    if (config?.[kind]?.enabled !== true) continue;
    const keyFile = path.join(root, 'state', directory, 'api.key');
    try {
      const endpoint = `http://127.0.0.1:${localSpeechPort(kind, config[kind])}/v1`;
      managedSpeech[capability] = { endpoint };
      const file = fs.lstatSync(keyFile);
      if (!file.isFile() || file.size > 130) continue;
      const key = fs.readFileSync(keyFile, 'ascii').trim();
      if (/^[A-Za-z0-9_-]{32,128}$/.test(key)) managedSpeech[capability].key = key;
    } catch {
      // During the first model load there may not yet be a credential file.
    }
  }
  return { managedSpeech };
}
