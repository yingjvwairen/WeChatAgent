import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import {
  OwnedSpeechProcesses,
  managedSpeechCommand,
  localSpeechPort,
  speechProfilesPath,
} from './local-speech-owned.mjs';
import { processIdentity } from './speech-process-identity.mjs';
import { SpeechLeases } from './local-speech-leases.mjs';
import { rosterFeatureSettings } from '../packages/plugin-api/catalog.mjs';
import { activeOf, servicesOf } from '../optional-extensions/speech-synthesis/ui/providers.mjs';

export function brokerPaths(root) {
  const canonical = fs.realpathSync(root);
  const hash = crypto
    .createHash('sha256')
    .update(process.platform === 'win32' ? canonical.toLowerCase() : canonical)
    .digest('hex')
    .slice(0, 24);
  return {
    socket:
      process.platform === 'win32'
        ? `\\\\.\\pipe\\wechatagent-speech-${hash}`
        : path.join(os.tmpdir(), `wca-speech-${hash}.sock`),
    descriptor: path.join(root, 'state/local-speech/broker.json'),
  };
}

function normalizeService(root, kind, config) {
  const service = {
    enabled: true,
    python: config.python,
    modelDirectory: config.modelDirectory,
    profiles: speechProfilesPath(root, kind, config),
    preload: config.preload || '',
    port: localSpeechPort(kind, config),
  };
  managedSpeechCommand(root, kind, service);
  return service;
}

export function normalizeServices(root, services, status) {
  const result = {};
  for (const kind of ['asr', 'tts']) {
    if (services?.[kind]?.enabled !== true) continue;
    try {
      // Match the workspace used by brokerPaths when deriving default profile paths.
      result[kind] = normalizeService(fs.realpathSync(root), kind, services[kind]);
    } catch {
      status[kind] = 'failed';
    }
  }
  return result;
}

export const speechServiceRevision = service =>
  service ? crypto.createHash('sha256').update(JSON.stringify(service)).digest('hex') : null;

export async function modelControl(root, kind, operation, body, config = {}, signals = []) {
  if (!['asr', 'tts'].includes(kind) || !['status', 'load'].includes(operation))
    throw Error('LOCAL_SPEECH_REQUEST_INVALID');
  const key = fs.readFileSync(path.join(root, 'state/local-speech', kind + '.control.key'), 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(key)) throw Error('LOCAL_SPEECH_CONTROL_UNAVAILABLE');
  const signal = AbortSignal.any([...signals, AbortSignal.timeout(operation === 'load' ? 180000 : 3000)]);
  const response = await fetch(`http://127.0.0.1:${localSpeechPort(kind, config)}/wca/${operation}`, {
    method: operation === 'load' ? 'POST' : 'GET',
    redirect: 'error',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    ...(operation === 'load' ? { body: JSON.stringify(body) } : {}),
    signal,
  });
  if (!response.ok) throw Error(response.status === 409 ? 'LOCAL_MODEL_REVISION_CHANGED' : 'LOCAL_MODEL_LOAD_FAILED');
  const result = await response.json();
  signal.throwIfAborted();
  if (result.version !== 1) throw Error('LOCAL_SPEECH_PROTOCOL_INVALID');
  return result;
}

function cloudAddress(value) {
  try {
    const url = new URL(value);
    return ['https:', 'wss:'].includes(url.protocol) && !/^(?:localhost(?:\.|$)|127\.|\[)/i.test(url.hostname);
  } catch {
    return false;
  }
}

const SPEECH_ROUTE_FEATURES = {
  asr: ['voice-input-v1', 'voice-dialogue-v1'],
  tts: ['voice-output-v1', 'voice-dialogue-v1'],
};

function cloudSpeechRoute({ id, feature, settings }) {
  if (id === 'speech-recognition') return feature === 'voice-input-v1' && cloudAddress(settings.endpoint);
  if (id !== 'speech-synthesis') return false;
  const services = servicesOf(settings);
  if (feature === 'voice-input-v1' && services.recognition === 'off') return false;
  const slot = feature !== 'voice-input-v1' ? 'tts' : services.recognition === 'realtime' ? 'realtimeAsr' : 'fileAsr';
  const active = activeOf(services, slot);
  if (!active.definition || active.definition.managed || active.definition.kind === 'gpt-sovits') return false;
  return active.entry !== 'custom' || cloudAddress(active.profile.endpoint);
}

function cloudOnlyServices(root) {
  try {
    const features = [...new Set(Object.values(SPEECH_ROUTE_FEATURES).flat())];
    const routes = rosterFeatureSettings(root, features);
    return Object.keys(SPEECH_ROUTE_FEATURES).filter(kind => {
      const relevant = routes.filter(route => SPEECH_ROUTE_FEATURES[kind].includes(route.feature));
      return relevant.length > 0 && relevant.every(cloudSpeechRoute);
    });
  } catch {
    return []; // An unreadable setting cannot establish a cloud-only switch.
  }
}

export async function runBroker(root, { identify = processIdentity, owner = new OwnedSpeechProcesses(root) } = {}) {
  const locations = brokerPaths(root);
  const token = crypto.randomBytes(32).toString('hex');
  const identity = await identify(process.pid);
  if (!identity) throw Error('LOCAL_SPEECH_OWNER_INVALID');
  const leases = new SpeechLeases({ identify });
  const sockets = new Map(),
    configured = new Map();
  const hasClients = () => [...leases.clients.keys()].some(id => sockets.get(id)?.destroyed === false);
  let stopping = false,
    idleSince = Date.now(),
    serial = Promise.resolve();
  const enqueue = operation => {
    const result = serial.then(operation);
    serial = result.catch(() => {});
    return result;
  };
  const reconcile = async (retryFailed = false) => {
    while (!stopping) {
      // All consumers of this broker share one workspace and its atomic, operator-saved settings.
      const invalid = {};
      const desired = hasClients()
        ? normalizeServices(
            root,
            JSON.parse(fs.readFileSync(path.join(root, 'config/wechatagent.json'), 'utf8').replace(/^\uFEFF/, ''))
              .runtime?.localSpeech ?? {},
            invalid,
          )
        : {};
      const cloudOnly = desired.asr || desired.tts ? cloudOnlyServices(root) : [];
      // Cancel every affected request before waiting for any service to stop.
      const updates = ['asr', 'tts'].map(kind => {
        const standby = !!desired[kind] && cloudOnly.includes(kind);
        const service = standby ? undefined : desired[kind];
        const previous = configured.get(kind);
        const replacing = previous && JSON.stringify(previous.config) !== JSON.stringify(service);
        if (replacing) previous.controller.abort(Error('LOCAL_MODEL_REVISION_CHANGED'));
        return { kind, standby, service, replacing };
      });
      const replacements = updates.filter(update => update.replacing);
      if (replacements.length) {
        for (const { kind } of replacements) {
          await owner.close(kind);
          if (stopping) return;
          configured.delete(kind);
        }
        // A save or disconnect can change the desired services while a process stops.
        continue;
      }
      for (const { kind, standby, service } of updates) {
        if (invalid[kind]) owner.status[kind] = 'failed';
        if (standby) owner.status[kind] = 'standby';
        else if (!invalid[kind] && !service && owner.status[kind]) owner.status[kind] = 'stopped';
        const active = configured.get(kind);
        if (
          service &&
          hasClients() &&
          (!active || active.controller.signal.aborted || (retryFailed && owner.status[kind] === 'failed'))
        ) {
          active?.controller.abort(Error('LOCAL_MODEL_REVISION_CHANGED'));
          configured.set(kind, { config: service, controller: new AbortController() });
          owner.start({ [kind]: service });
        }
      }
      if (hasClients()) idleSince = null;
      else idleSince ??= Date.now();
      return;
    }
  };
  const server = net.createServer(socket => {
    const id = crypto.randomUUID();
    const connection = new AbortController();
    let authorized = false,
      buffered = 0;
    sockets.set(id, socket);
    const lines = createInterface({ input: socket });
    socket.on('data', chunk => {
      buffered += chunk.length;
      if (buffered > 65536) socket.destroy();
    });
    const send = value => {
      if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n');
    };
    lines.on('line', line => {
      buffered = 0;
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        socket.destroy();
        return;
      }
      if (!request || typeof request.id !== 'number') {
        socket.destroy();
        return;
      }
      if (authorized && request.op === 'heartbeat') {
        try {
          leases.touch(id);
          send({ id: request.id, ok: true, result: owner.status });
        } catch {
          socket.destroy();
        }
        return;
      }
      enqueue(async () => {
        if (socket.destroyed) return;
        if (!authorized) {
          if (request.op !== 'hello' || request.token !== token) throw Error('LOCAL_SPEECH_UNAUTHORIZED');
          await leases.acquire(id, request.identity);
          if (socket.destroyed || stopping) {
            leases.release(id);
            return;
          }
          authorized = true;
          idleSince = null;
          return { version: 1 };
        }
        leases.touch(id);
        if (request.op === 'configure') {
          await reconcile(true);
          return owner.status;
        }
        if (request.op === 'status') return owner.status;
        if (request.op === 'model') {
          const { kind, operation, body, serviceRevision } = request;
          await reconcile();
          if (socket.destroyed || stopping) return;
          const service = configured.get(kind);
          if (!service) throw Error('LOCAL_SPEECH_NOT_ENABLED');
          // Loads bind both the service configuration and the profile revision in the request body.
          if (operation === 'load' && serviceRevision !== speechServiceRevision(service.config))
            throw Error('LOCAL_MODEL_REVISION_CHANGED');
          if (owner.status[kind] !== 'ready') throw Error('LOCAL_SPEECH_NOT_READY');
          // The Python inference lock serializes model loading. Keep the lease
          // queue free so disconnects can stop even an unfinished model load.
          return {
            modelRequest: modelControl(root, kind, operation, body, service.config, [
              connection.signal,
              service.controller.signal,
            ]),
          };
        }
        throw Error('LOCAL_SPEECH_REQUEST_INVALID');
      })
        .then(async result =>
          send({ id: request.id, ok: true, result: result?.modelRequest ? await result.modelRequest : result }),
        )
        .catch(error => {
          send({
            id: request.id,
            ok: false,
            error: /^LOCAL_[A-Z_]+$/.test(error.message) ? error.message : 'LOCAL_SPEECH_UNAVAILABLE',
          });
          if (!authorized) socket.destroy();
        });
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      connection.abort(Error('LOCAL_SPEECH_DISCONNECTED'));
      lines.close();
      sockets.delete(id);
      leases.release(id);
      enqueue(reconcile).catch(() => {});
    });
    const helloDeadline = setTimeout(() => {
      if (!authorized) socket.destroy();
    }, 10000);
    helloDeadline.unref();
    socket.once('close', () => clearTimeout(helloDeadline));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(locations.socket, resolve);
  });
  try {
    fs.mkdirSync(path.dirname(locations.descriptor), { recursive: true });
    fs.writeFileSync(locations.descriptor, JSON.stringify({ version: 1, ...identity, token }), { mode: 0o600 });
  } catch (error) {
    stopping = true;
    for (const socket of sockets.values()) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    throw error;
  }
  const close = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    for (const { controller } of configured.values()) controller.abort(Error('LOCAL_SPEECH_DISCONNECTED'));
    for (const socket of sockets.values()) socket.destroy();
    server.close();
    await owner.close();
    try {
      if (JSON.parse(fs.readFileSync(locations.descriptor, 'utf8')).token === token)
        fs.unlinkSync(locations.descriptor);
    } catch {}
  };
  let checking = false;
  const timer = setInterval(async () => {
    if (stopping || checking) return;
    checking = true;
    try {
      for (const id of await leases.expire()) sockets.get(id)?.destroy();
      await enqueue(reconcile);
      if (idleSince !== null && Date.now() - idleSince > 15000) await close();
    } catch {
      /* A temporary process query failure is retried at the next lease sweep. */
    } finally {
      checking = false;
    }
  }, 4000);
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  return { close, owner, leases };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  if (!root) process.exitCode = 2;
  else
    runBroker(path.resolve(root)).catch(() => {
      process.exitCode = 1;
    });
}
