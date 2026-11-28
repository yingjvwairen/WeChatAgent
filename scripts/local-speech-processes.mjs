import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { brokerPaths, normalizeServices } from './local-speech-broker.mjs';
import { processIdentity } from './speech-process-identity.mjs';
export { managedSpeechCommand } from './local-speech-owned.mjs';

// Desktop and adapter each own a lease; only the broker owns model subprocesses.
export class LocalSpeechProcesses {
  constructor(root, { spawnImpl = spawn, identify = processIdentity, nodeExecutable = process.execPath } = {}) {
    this.nodeExecutable = nodeExecutable;
    this.root = root;
    this.spawn = spawnImpl;
    this.identify = identify;
    this.status = {};
    this.requests = new Map();
    this.sequence = 0;
    this.closed = false;
    this.services = {};
    this.operation = Promise.resolve();
  }
  start(services = {}) {
    if (this.closed) return this.status;
    clearTimeout(this.reconnectTimer);
    this.services = normalizeServices(this.root, services, this.status);
    for (const kind of Object.keys(this.services)) this.status[kind] ??= 'starting';
    const snapshot = this.services;
    this.operation = this.operation
      .catch(() => {})
      .then(async () => {
        if (!Object.keys(snapshot).length && !this.socket) return;
        await this.connect();
        Object.assign(this.status, await this.request('configure'));
      })
      .catch(() => {
        for (const kind of Object.keys(snapshot)) this.status[kind] = 'failed';
      });
    return this.status;
  }
  async connect() {
    if (this.closed) throw Error('LOCAL_SPEECH_CLOSED');
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }
  async open() {
    const identity = await this.identify(process.pid);
    if (!identity) throw Error('LOCAL_SPEECH_OWNER_INVALID');
    const locations = brokerPaths(this.root);
    let launched = false;
    const deadline = Date.now() + 15000;
    while (!this.closed && Date.now() < deadline) {
      let socket;
      try {
        const descriptor = JSON.parse(fs.readFileSync(locations.descriptor, 'utf8'));
        if (descriptor.version !== 1 || !/^[a-f0-9]{64}$/.test(descriptor.token))
          throw Error('LOCAL_SPEECH_DESCRIPTOR_INVALID');
        socket = net.createConnection(locations.socket);
        await new Promise((resolve, reject) => {
          socket.once('connect', resolve);
          socket.once('error', reject);
        });
        if (this.closed) {
          socket.destroy();
          throw Error('LOCAL_SPEECH_CLOSED');
        }
        this.socket = socket;
        let authenticated = false;
        const lines = createInterface({ input: socket });
        lines.on('line', line => {
          let answer;
          try {
            answer = JSON.parse(line);
          } catch {
            socket.destroy();
            return;
          }
          const pending = this.requests.get(answer.id);
          if (!pending) return;
          this.requests.delete(answer.id);
          clearTimeout(pending.timer);
          answer.ok
            ? pending.resolve(answer.result)
            : pending.reject(Error(answer.error || 'LOCAL_SPEECH_UNAVAILABLE'));
        });
        socket.on('error', () => {});
        socket.on('close', () => {
          lines.close();
          for (const [id, pending] of this.requests) {
            if (pending.socket !== socket) continue;
            clearTimeout(pending.timer);
            pending.reject(Error('LOCAL_SPEECH_DISCONNECTED'));
            this.requests.delete(id);
          }
          if (this.socket !== socket) return;
          clearInterval(this.heartbeat);
          this.socket = null;
          if (authenticated && !this.closed && Object.keys(this.services).length) {
            for (const kind of Object.keys(this.services)) this.status[kind] = 'starting';
            this.reconnectTimer = setTimeout(() => this.start(this.services), 1000);
            this.reconnectTimer.unref();
          }
        });
        await this.request('hello', { token: descriptor.token, identity });
        authenticated = true;
        this.heartbeat = setInterval(
          () =>
            this.request('heartbeat')
              .then(status => Object.assign(this.status, status))
              .catch(() => socket.destroy()),
          3000,
        );
        this.heartbeat.unref();
        return;
      } catch {
        socket?.destroy();
        this.socket = null;
        if (!launched && !this.closed) {
          launched = true;
          const child = this.spawn(
            this.nodeExecutable,
            [path.join(this.root, 'scripts/local-speech-broker.mjs'), this.root],
            { cwd: this.root, windowsHide: true, detached: true, stdio: 'ignore', shell: false },
          );
          child.on('error', () => {});
          child.unref();
        }
        await delay(100);
      }
    }
    throw Error('LOCAL_SPEECH_UNAVAILABLE');
  }
  request(op, data = {}) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(Error('LOCAL_SPEECH_DISCONNECTED'));
        return;
      }
      const id = ++this.sequence;
      const timer = setTimeout(
        () => {
          this.requests.delete(id);
          reject(Error('LOCAL_SPEECH_TIMEOUT'));
        },
        op === 'model' && data.operation === 'load' ? 190000 : 15000,
      );
      this.requests.set(id, { resolve, reject, timer, socket: this.socket });
      this.socket.write(JSON.stringify({ id, op, ...data }) + '\n');
    });
  }
  async ready(kind, timeoutMs = 180000) {
    await this.operation;
    const deadline = Date.now() + timeoutMs;
    do {
      const status = await this.request('status');
      Object.assign(this.status, status);
      if (status[kind] === 'ready') return;
      if (status[kind] !== 'starting') throw Error('LOCAL_SPEECH_NOT_READY');
      await delay(250);
    } while (Date.now() < deadline);
    throw Error('LOCAL_SPEECH_TIMEOUT');
  }
  async model(kind, operation, body) {
    await this.ready(kind);
    return this.request('model', { kind, operation, body });
  }
  modelStatus(kind) {
    return this.request('model', { kind, operation: 'status' });
  }
  async close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeat);
    this.socket?.destroy();
    await this.operation;
    for (const kind of Object.keys(this.status)) this.status[kind] = 'stopped';
  }
}
