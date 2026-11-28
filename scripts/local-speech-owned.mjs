import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { localSpeechPort } from '../packages/plugin-api/contract.mjs';

export { localSpeechPort };

function localPath(root, value) {
  if (typeof value !== 'string' || !value.trim() || /[\x00\r\n"]/.test(value) || /^[\\/]{2}/.test(value)) {
    throw Error('LOCAL_SPEECH_PATH_INVALID');
  }
  return path.resolve(root, value);
}

export const defaultProfilesPath = (root, kind) => path.join(root, 'state/local-speech', kind + '.profiles.json');

export function speechProfilesPath(root, kind, config) {
  const fallback = defaultProfilesPath(root, kind);
  return config.profiles || (kind === 'tts' || fs.existsSync(fallback) ? fallback : '');
}

export function managedSpeechCommand(root, kind, config) {
  const python = localPath(root, config.python);
  if (!/^(?:python(?:3(?:\.\d+)?)?)(?:\.exe)?$/i.test(path.basename(python)) || !fs.statSync(python).isFile()) {
    throw Error('LOCAL_SPEECH_PYTHON_INVALID');
  }
  const profiles = speechProfilesPath(root, kind, config);
  const args = ['-I', '-B', '-u', path.join(root, 'scripts/local-speech-host.py'), kind];
  if (kind === 'asr') {
    if (profiles) args.push('--profiles', localPath(root, profiles));
    else args.push('--model-dir', localPath(root, config.modelDirectory));
  } else if (kind === 'tts') {
    args.push('--profiles', localPath(root, profiles), '--model-root', localPath(root, config.modelDirectory));
  } else throw Error('LOCAL_SPEECH_SERVICE_INVALID');
  if (config.preload) args.push('--preload', config.preload);
  args.push(
    '--control-key-file',
    path.join(root, 'state/local-speech', kind + '.control.key'),
    '--selection-file',
    path.join(root, 'state/local-speech', kind + '.selection.json'),
    '--port',
    String(localSpeechPort(kind, config)),
  );
  return { python, args };
}

export class OwnedSpeechProcesses {
  constructor(root, spawnImpl = spawn) {
    this.root = root;
    this.spawn = spawnImpl;
    this.status = {};
    this.children = new Map();
  }

  start(services = {}) {
    for (const kind of ['asr', 'tts']) {
      const config = services?.[kind];
      if (config?.enabled !== true || this.children.has(kind)) continue;
      try {
        const { python, args } = managedSpeechCommand(this.root, kind, config);
        const child = this.spawn(python, args, {
          cwd: this.root,
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true,
          shell: false,
        });
        this.status[kind] = 'starting';
        const lines = createInterface({ input: child.stdout });
        lines.on('line', line => {
          if (line === 'WECHATAGENT_LOCAL_SPEECH_READY' && this.status[kind] === 'starting')
            this.status[kind] = 'ready';
        });
        child.stdin.on('error', () => {});
        child.on('error', () => {
          this.status[kind] = 'failed';
        });
        const exited = new Promise(resolve =>
          child.once('close', () => {
            this.status[kind] = this.status[kind] === 'stopping' ? 'stopped' : 'failed';
            this.children.delete(kind);
            lines.close();
            resolve();
          }),
        );
        this.children.set(kind, { child, exited });
      } catch {
        this.status[kind] = 'failed';
      }
    }
    return this.status;
  }

  async close(onlyKind) {
    await Promise.all(
      Array.from(this.children)
        .filter(([kind]) => !onlyKind || onlyKind === kind)
        .map(async ([kind, { child, exited }]) => {
          this.status[kind] = 'stopping';
          child.stdin.end();
          const timeout = setTimeout(() => child.kill(), 12000);
          try {
            await exited;
          } finally {
            clearTimeout(timeout);
          }
        }),
    );
  }
}
