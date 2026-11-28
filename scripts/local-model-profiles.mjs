import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LocalSpeechProcesses } from './local-speech-processes.mjs';
import { defaultProfilesPath, localSpeechPort } from './local-speech-owned.mjs';
export { defaultProfilesPath } from './local-speech-owned.mjs';
import { MODEL_FIELDS, VOICE_PARAMETERS } from '../packages/speech-contract/model-schema.mjs';
import { atomicJson } from '../packages/extension-runtime/catalog.mjs';
export { VOICE_PARAMETERS } from '../packages/speech-contract/model-schema.mjs';

const kinds = ['asr', 'tts'];
const hash = raw => crypto.createHash('sha256').update(raw).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const inside = (base, file) => {
  const rel = path.relative(base, file);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
};
const settingsFile = (root, kind, config) => path.resolve(root, config.profiles || defaultProfilesPath(root, kind));

function readProfiles(file) {
  if (!fs.existsSync(file)) return { profiles: {}, revision: hash(''), saved: false };
  if (fs.statSync(file).size > 65536) throw Error('LOCAL_MODEL_SETTINGS_TOO_LARGE');
  const raw = fs.readFileSync(file);
  const profiles = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
  if (!plain(profiles)) throw Error('LOCAL_MODEL_SETTINGS_INVALID');
  return { profiles, revision: hash(raw), saved: true };
}

function configuredProfiles(root, kind, config, file) {
  const stored = readProfiles(file);
  if (stored.saved || kind !== 'asr' || config.profiles || !config.modelDirectory) return stored;
  const modelDirectory = path.resolve(root, config.modelDirectory);
  return {
    ...stored,
    profiles: { default: { name: '默认识别模型', modelDirectory } },
    revision: hash(JSON.stringify([null, modelDirectory])),
  };
}

export function validateProfiles(root, kind, config, rows) {
  if (
    !kinds.includes(kind) ||
    !plain(rows) ||
    Object.keys(rows).length < 1 ||
    Object.keys(rows).length > (kind === 'asr' ? 32 : 64)
  )
    throw Error('LOCAL_MODEL_PROFILES_INVALID');
  const result = {},
    base =
      kind === 'tts'
        ? fs.realpathSync(path.resolve(root, config.modelDirectory || ''))
        : path.dirname(settingsFile(root, kind, config));
  for (const [id, row] of Object.entries(rows)) {
    const validId = kind === 'asr' ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id) : /^[\p{L}\p{N}_-]{1,64}$/u.test(id);
    const fields = MODEL_FIELDS[kind].map(field => field.key);
    if (
      !validId ||
      !plain(row) ||
      Object.keys(row).some(key => !fields.includes(key)) ||
      Object.entries(row).some(([key, value]) =>
        kind === 'tts' && Object.hasOwn(VOICE_PARAMETERS, key)
          ? typeof value !== 'number'
          : typeof value !== 'string' || /\0/.test(value),
      ) ||
      (row.name || '').length > 80
    )
      throw Error('LOCAL_MODEL_PROFILE_INVALID');
    const normalized = { ...row };
    if (kind === 'tts') {
      for (const [key, [min, max, fallback]] of Object.entries(VOICE_PARAMETERS)) {
        const value = row[key] ?? fallback;
        if (!Number.isFinite(value) || value < min || value > max || (key === 'topK' && !Number.isInteger(value)))
          throw Error('LOCAL_MODEL_PARAMETER_INVALID');
        normalized[key] = value;
      }
      if (!/^cut[0-5]$/.test(row.textSplitMethod || 'cut2')) throw Error('LOCAL_MODEL_PARAMETER_INVALID');
      normalized.textSplitMethod = row.textSplitMethod || 'cut2';
      const suffixes = {
        gptWeights: ['.ckpt'],
        sovitsWeights: ['.pth'],
        refAudio: ['.wav', '.flac', '.mp3', '.ogg', '.m4a', '.aac'],
      };
      for (const [key, extensions] of Object.entries(suffixes)) {
        if (!row[key] || /^[\\/]{2}/.test(row[key])) throw Error('LOCAL_MODEL_ASSET_INVALID');
        const file = fs.realpathSync(path.resolve(base, row[key]));
        if (
          !inside(base, file) ||
          !fs.statSync(file).isFile() ||
          !extensions.includes(path.extname(file).toLowerCase())
        )
          throw Error('LOCAL_MODEL_ASSET_INVALID');
        normalized[key] = file;
      }
      if (
        (row.promptText || '').length > 4000 ||
        !/^[a-z_]{1,32}$/.test(row.promptLang || 'zh') ||
        !/^[a-z_]{1,32}$/.test(row.textLang || 'zh')
      )
        throw Error('LOCAL_MODEL_LANGUAGE_INVALID');
    } else {
      if (!row.modelDirectory || /^[\\/]{2}/.test(row.modelDirectory)) throw Error('LOCAL_MODEL_ASSET_INVALID');
      const folder = fs.realpathSync(path.resolve(base, row.modelDirectory));
      if (!['model.bin', 'tokenizer.json', 'config.json'].every(file => fs.statSync(path.join(folder, file)).isFile()))
        throw Error('LOCAL_MODEL_ASSET_INVALID');
      if ((row.language && !/^[a-z]{2,3}$/.test(row.language)) || (row.initialPrompt || '').length > 500)
        throw Error('LOCAL_MODEL_LANGUAGE_INVALID');
      normalized.modelDirectory = folder;
    }
    result[id] = normalized;
  }
  return result;
}

export function discoverModels(root, kind, config) {
  if (!kinds.includes(kind)) throw Error('LOCAL_MODEL_DIRECTORY_REQUIRED');
  const configured = config.modelDirectory ? path.resolve(root, config.modelDirectory) : null;
  const base =
    configured && (kind === 'tts' || fs.statSync(configured, { throwIfNoEntry: false })?.isDirectory())
      ? fs.realpathSync(configured)
      : null;
  const installedDirectory = path.join(root, 'state/local-whisper/models');
  const installed =
    kind === 'asr' && fs.lstatSync(installedDirectory, { throwIfNoEntry: false })?.isDirectory()
      ? fs.realpathSync(installedDirectory)
      : null;
  if (!base && !installed) throw Error('LOCAL_MODEL_DIRECTORY_REQUIRED');
  const found = { gptWeights: [], sovitsWeights: [], refAudio: [], modelDirectory: [] };
  const visited = new Set();
  let entries = 0,
    truncated = false;
  const walk = (folder, depth) => {
    if (visited.has(folder)) return;
    if (entries >= 3000 || depth > 5) {
      truncated = true;
      return;
    }
    visited.add(folder);
    const rows = fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    if (
      kind === 'asr' &&
      ['model.bin', 'tokenizer.json', 'config.json'].every(name => rows.some(row => row.name === name && row.isFile()))
    )
      found.modelDirectory.push(folder);
    for (const row of rows) {
      if (++entries > 3000) {
        truncated = true;
        break;
      }
      if (row.isSymbolicLink()) continue;
      const file = path.join(folder, row.name);
      if (row.isDirectory() && !['.git', '__pycache__', 'node_modules', 'site-packages'].includes(row.name))
        walk(file, depth + 1);
      if (!row.isFile() || kind !== 'tts') continue;
      const ext = path.extname(file).toLowerCase();
      const key =
        ext === '.ckpt'
          ? 'gptWeights'
          : ext === '.pth'
            ? 'sovitsWeights'
            : ['.wav', '.flac', '.mp3', '.ogg', '.m4a', '.aac'].includes(ext)
              ? 'refAudio'
              : null;
      if (key && found[key].length < 300) found[key].push(file);
    }
  };
  if (installed) walk(installed, 0);
  if (base) walk(base, 0);
  return { kind, root: base ?? installed, candidates: found, truncated };
}

// Console routes provide their usual authentication and config serialization.
// This component only manages model files and operator loading; it never grants plugin access.
export function createLocalModelControls({
  root,
  readConfig,
  nodeExecutable,
  manager = new LocalSpeechProcesses(root, { nodeExecutable }),
}) {
  let settingsRevision = null;
  const refresh = () => {
    const services = readConfig().runtime?.localSpeech || {};
    const revision = JSON.stringify(services);
    if (revision !== settingsRevision) {
      settingsRevision = revision;
      manager.start(services);
    }
  };
  try {
    refresh();
  } catch {
    /* First-run console may not have saved its configuration yet. */
  }
  const configFor = kind => {
    if (!kinds.includes(kind)) throw Error('LOCAL_MODEL_KIND_INVALID');
    return readConfig().runtime?.localSpeech?.[kind] || {};
  };
  const selected = (kind, profiles) => {
    let name;
    try {
      name = JSON.parse(
        fs.readFileSync(path.join(root, 'state/local-speech', kind + '.selection.json'), 'utf8'),
      ).profile;
    } catch {
      /* The service initially selects the first configured profile. */
    }
    return Object.hasOwn(profiles, name) ? name : (Object.keys(profiles)[0] ?? null);
  };
  const view = async () => {
    refresh();
    return Object.fromEntries(
      await Promise.all(
        kinds.map(async kind => {
          const config = configFor(kind),
            file = settingsFile(root, kind, config);
          let stored,
            error = null;
          try {
            stored = configuredProfiles(root, kind, config, file);
          } catch {
            stored = { profiles: {}, revision: null };
            error = 'LOCAL_MODEL_SETTINGS_INVALID';
          }
          const selectedProfile = selected(kind, stored.profiles);
          let phase = config.enabled === true ? manager.status[kind] || 'stopped' : 'stopped';
          let loadedProfile = null;
          let loadedRevision = null;
          if (phase === 'ready') {
            try {
              const model = await manager.modelStatus(kind);
              loadedProfile = typeof model.loadedProfile === 'string' ? model.loadedProfile : null;
              loadedRevision =
                model.phase === 'ready' && loadedProfile && typeof model.revision === 'string' ? model.revision : null;
              if (['starting', 'loading', 'failed'].includes(model.phase)) phase = model.phase;
              else if (model.phase !== 'ready' || !loadedRevision || error) phase = 'unavailable';
              else phase = loadedRevision === stored.revision ? 'ready' : 'saved';
            } catch {
              phase = 'unavailable';
            }
          }
          return [
            kind,
            {
              kind,
              enabled: config.enabled === true,
              profilesPath: file,
              ...stored,
              selectedProfile,
              loadedProfile,
              loadedRevision,
              phase,
              error,
              endpoint: `http://127.0.0.1:${localSpeechPort(kind, config)}/v1`,
              model: 'default',
              apiKeyFile: path.join(
                root,
                kind === 'asr' ? 'state/local-whisper/api.key' : 'state/local-gpt-sovits/api.key',
              ),
            },
          ];
        }),
      ),
    );
  };
  return {
    refresh,
    view,
    saveProfiles({ kind, profiles, revision }) {
      const config = configFor(kind),
        file = settingsFile(root, kind, config);
      const previous = configuredProfiles(root, kind, config, file);
      if (previous.revision !== revision) throw Error('LOCAL_MODEL_REVISION_CHANGED');
      const validated = validateProfiles(root, kind, config, profiles);
      const current = previous.saved ? selected(kind, previous.profiles) : null;
      if (current && !Object.hasOwn(validated, current)) throw Error('LOCAL_MODEL_SELECTED_PROFILE_REQUIRED');
      const raw = JSON.stringify(validated, null, 2) + '\n';
      if (Buffer.byteLength(raw) > 65536) throw Error('LOCAL_MODEL_SETTINGS_TOO_LARGE');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = file + '.' + crypto.randomUUID() + '.tmp';
      try {
        fs.writeFileSync(temp, raw, { mode: 0o600 });
        fs.renameSync(temp, file);
      } finally {
        fs.rmSync(temp, { force: true });
      }
      return view();
    },
    discover({ kind }) {
      return discoverModels(root, kind, configFor(kind));
    },
    async use({ kind, profile, revision }) {
      const config = configFor(kind),
        file = settingsFile(root, kind, config),
        stored = readProfiles(file);
      if (stored.revision !== revision) throw Error('LOCAL_MODEL_REVISION_CHANGED');
      if (!stored.profiles[profile] || config.enabled !== true) throw Error('LOCAL_MODEL_NOT_ENABLED');
      const configuration = JSON.stringify(config);
      const assertUnchanged = () => {
        if (JSON.stringify(configFor(kind)) !== configuration || readProfiles(file).revision !== revision)
          throw Error('LOCAL_MODEL_REVISION_CHANGED');
      };
      manager.start(readConfig().runtime.localSpeech);
      await manager.operation;
      assertUnchanged();
      const standby = manager.status[kind] === 'standby';
      if (standby) {
        atomicJson(path.join(root, 'state/local-speech', kind + '.selection.json'), { version: 1, profile });
      } else {
        const loaded = await manager.model(kind, 'load', { profile, revision }, assertUnchanged);
        if (
          !loaded.loaded ||
          loaded.selectedProfile !== profile ||
          loaded.loadedProfile !== profile ||
          loaded.revision !== revision
        )
          throw Error('LOCAL_MODEL_LOAD_UNCONFIRMED');
      }
      const current = await view();
      assertUnchanged();
      return { ...current, loaded: { kind, profile, phase: standby ? 'standby' : 'ready' } };
    },
    close() {
      return manager.close();
    },
  };
}
