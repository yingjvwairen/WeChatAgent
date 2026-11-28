import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter, once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { SpeechLeases } from './local-speech-leases.mjs';
import { LocalSpeechProcesses } from './local-speech-processes.mjs';
import { brokerPaths, runBroker, normalizeServices } from './local-speech-broker.mjs';
import { processIdentity, sameProcess } from './speech-process-identity.mjs';

test('lease expiry detects PID reuse, process death, and missed heartbeat independently', async () => {
  let now = 100,
    live = { pid: 17, created: '1' };
  const leases = new SpeechLeases({ identify: async () => live, now: () => now, timeoutMs: 10 });
  await leases.acquire('one', live);
  live = { pid: 17, created: '2' };
  assert.deepEqual(await leases.expire(), ['one']);
  assert.equal(leases.clients.size, 0);
  await leases.acquire('two', live);
  now = 111;
  assert.deepEqual(await leases.expire(), ['two']);
  await leases.acquire('three', live);
  live = null;
  assert.deepEqual(await leases.expire(), ['three']);
  await assert.rejects(leases.acquire('invalid', { pid: 17, created: '1' }), /OWNER_INVALID/);
});

test('local IPC shares both models and releases only the service switched to cloud', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-owner-'));
  const python = path.join(root, 'python.exe');
  fs.writeFileSync(python, '');
  const identity = { pid: process.pid, created: 'fixture-creation' },
    identify = async pid => (pid === process.pid ? identity : null);
  const starts = { asr: 0, tts: 0 },
    stops = { asr: 0, tts: 0 };
  const owner = {
    status: {},
    start(services) {
      for (const kind of Object.keys(services)) {
        starts[kind]++;
        this.status[kind] = 'ready';
      }
    },
    async close(kind) {
      for (const key of kind ? [kind] : Object.keys(this.status))
        if (this.status[key] === 'ready') {
          stops[key]++;
          this.status[key] = 'stopped';
        }
    },
  };
  const broker = await runBroker(root, { owner, identify });
  const desktop = new LocalSpeechProcesses(root, {
    identify,
    spawnImpl() {
      throw Error('broker must be reused');
    },
  });
  const adapter = new LocalSpeechProcesses(root, {
    identify,
    spawnImpl() {
      throw Error('broker must be reused');
    },
  });
  t.after(async () => {
    await desktop.close();
    await adapter.close();
    await broker.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const services = {
    asr: { enabled: true, python, modelDirectory: root },
    tts: { enabled: true, python, modelDirectory: root },
  };
  fs.mkdirSync(path.join(root, 'config'));
  const account = 'a'.repeat(64);
  fs.mkdirSync(path.join(root, 'state/weflow'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state/weflow/active-account.json'), JSON.stringify({ id: account }));
  for (const id of ['speech-recognition', 'speech-synthesis']) {
    const plugin = path.join(root, 'plugins', id);
    fs.mkdirSync(plugin, { recursive: true });
    fs.copyFileSync(
      path.resolve(import.meta.dirname, '../optional-extensions', id, 'plugin.json'),
      path.join(plugin, 'plugin.json'),
    );
  }
  const save = localSpeech =>
    fs.writeFileSync(
      path.join(root, 'config/wechatagent.json'),
      JSON.stringify({
        runtime: { localSpeech },
        wechat: { whitelist: { private: ['desk', 'mobile'], groups: [] } },
      }),
    );
  const saveProviders = (endpoint, { synthesis = false, cloudTts = false } = {}) =>
    fs.writeFileSync(
      path.join(root, 'config/plugins.json'),
      JSON.stringify({
        version: 1,
        plugins: {
          'speech-recognition': {
            enabled: true,
            permissions: ['audio_read'],
            chatScopes: { [account]: { 'wechat:private:desk': 'legacy' } },
            settings: { endpoint, model: 'default' },
          },
          'speech-synthesis': {
            enabled: synthesis,
            permissions: ['audio_read', 'audio_synthesize'],
            chatScopes: { [account]: { 'wechat:private:mobile': 'legacy' } },
            settings: {
              voiceMode: 'separate',
              recognitionModel: 'default',
              services: {
                version: 2,
                recognition: 'file',
                tts: cloudTts
                  ? {
                      entry: 'custom',
                      method: 'speech',
                      profiles: { 'custom/speech': { endpoint: 'https://tts.example.test/v1', model: 'voice' } },
                    }
                  : { entry: 'gpt-sovits', method: 'local' },
                fileAsr: {
                  entry: 'custom',
                  method: 'transcriptions',
                  profiles: { 'custom/transcriptions': { endpoint: 'http://127.0.0.1:8102/v1', model: 'default' } },
                },
              },
            },
          },
        },
      }),
    );
  save(services);
  desktop.start(services);
  adapter.start(services);
  await Promise.all([desktop.ready('asr', 1000), adapter.ready('tts', 1000)]);
  assert.deepEqual(starts, { asr: 1, tts: 1 });
  assert.equal(broker.leases.clients.size, 2);
  const changed = { ...services, asr: { ...services.asr, port: 8102 } };
  save(changed);
  desktop.start(changed);
  adapter.start(services);
  await Promise.all([desktop.ready('asr', 1000), adapter.ready('asr', 1000)]);
  assert.deepEqual(starts, { asr: 2, tts: 1 });
  assert.deepEqual(stops, { asr: 1, tts: 0 });
  saveProviders('https://asr.example.test/v1', { synthesis: true });
  assert.deepEqual(await desktop.request('configure'), { asr: 'ready', tts: 'ready' });

  saveProviders('https://asr.example.test/v1', { synthesis: true, cloudTts: true });
  assert.deepEqual(await desktop.request('configure'), { asr: 'ready', tts: 'standby' });
  assert.deepEqual(stops, { asr: 1, tts: 1 });
  assert.equal(broker.leases.clients.size, 2);
  saveProviders('https://asr.example.test/v1', { synthesis: true });
  assert.deepEqual(await adapter.request('configure'), { asr: 'ready', tts: 'ready' });
  assert.deepEqual(starts, { asr: 2, tts: 2 });

  saveProviders('https://asr.example.test/v1');
  for (let i = 0; i < 120 && owner.status.asr !== 'standby'; i++) await delay(50);
  assert.equal(owner.status.asr, 'standby');
  assert.equal(owner.status.tts, 'ready');
  assert.deepEqual(stops, { asr: 2, tts: 1 });
  assert.equal(broker.leases.clients.size, 2);
  saveProviders('http://127.0.0.1:8102/v1');
  assert.equal((await adapter.request('configure')).asr, 'ready');
  assert.deepEqual(starts, { asr: 3, tts: 2 });
  await desktop.close();
  await delay(30);
  assert.deepEqual(stops, { asr: 2, tts: 1 });
  assert.equal(broker.leases.clients.size, 1);
  await adapter.close();
  await delay(30);
  assert.deepEqual(stops, { asr: 3, tts: 2 });
  assert.equal(broker.leases.clients.size, 0);
});

function speechBrokerFixture() {
  const temporary = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporary, 'speech-broker-boundary-'));
  const python = path.join(root, 'python.exe');
  fs.writeFileSync(python, '');
  fs.mkdirSync(path.join(root, 'config'));
  const locations = brokerPaths(root);
  const identity = { pid: process.pid, created: 'fixture-broker' };
  const identify = async pid => (pid === identity.pid ? identity : null);
  const services = { asr: { enabled: true, python, modelDirectory: root } };
  const save = localSpeech =>
    fs.writeFileSync(path.join(root, 'config/wechatagent.json'), JSON.stringify({ runtime: { localSpeech } }));
  save(services);
  const clean = () => {
    const actual = fs.realpathSync(root);
    assert.equal(path.dirname(actual), temporary);
    assert.match(path.basename(actual), /^speech-broker-boundary-[a-z0-9]+$/i);
    fs.rmSync(actual, { recursive: true, force: true });
  };
  return { root, locations, identify, services, save, clean };
}

test('a disconnected hello cannot acquire a lease after its process identity check returns', async t => {
  const f = speechBrokerFixture();
  const requester = { pid: process.pid + 1, created: 'fixture-requester' };
  const identifying = Promise.withResolvers();
  const release = Promise.withResolvers();
  const identify = async pid => {
    if (pid !== requester.pid) return f.identify(pid);
    identifying.resolve();
    await release.promise;
    return requester;
  };
  const starts = [];
  const owner = {
    status: {},
    start(services) {
      starts.push(...Object.keys(services));
    },
    async close() {},
  };
  const createServer = t.mock.method(net, 'createServer');
  const broker = await runBroker(f.root, { owner, identify });
  const server = createServer.mock.calls[0].result;
  const acquire = t.mock.method(broker.leases, 'acquire');
  const accepted = once(server, 'connection');
  const socket = net.createConnection(f.locations.socket);
  t.after(async () => {
    release.resolve();
    socket.destroy();
    await broker.close();
    f.clean();
  });
  await once(socket, 'connect');
  const [peer] = await accepted;
  const token = JSON.parse(fs.readFileSync(f.locations.descriptor, 'utf8')).token;
  socket.write(JSON.stringify({ id: 1, op: 'hello', token, identity: requester }) + '\n');
  await identifying.promise;
  const disconnected = once(peer, 'close');
  socket.destroy();
  try {
    await disconnected;
  } finally {
    release.resolve();
  }
  await acquire.mock.calls[0].result;
  await delay(0);

  assert.equal(broker.leases.clients.size, 0);
  assert.deepEqual(starts, []);
});

test('a failed speech descriptor publication releases the IPC listener so startup can retry', async t => {
  const f = speechBrokerFixture();
  fs.mkdirSync(f.locations.descriptor, { recursive: true });
  const createServer = t.mock.method(net, 'createServer');
  let broker;
  t.after(async () => {
    await broker?.close();
    for (const { result: server } of createServer.mock.calls)
      if (server?.listening) await new Promise(resolve => server.close(resolve));
    f.clean();
  });

  await assert.rejects(runBroker(f.root, { identify: f.identify }), error =>
    ['EISDIR', 'EPERM', 'EACCES'].includes(error.code),
  );
  assert.equal(createServer.mock.calls[0].result.listening, false);
  fs.rmdirSync(f.locations.descriptor);
  broker = await runBroker(f.root, { identify: f.identify });
  assert.equal(createServer.mock.calls[1].result.listening, true);
  assert.equal(JSON.parse(fs.readFileSync(f.locations.descriptor, 'utf8')).version, 1);
});

test('a speech service stays stopped when its last requester leaves during reconfiguration', async t => {
  const f = speechBrokerFixture();
  const stopping = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const disconnected = Promise.withResolvers();
  const starts = [];
  const owner = {
    status: {},
    start(services) {
      starts.push(services.asr.port);
      this.status.asr = 'ready';
    },
    async close(kind) {
      if (kind === 'asr') {
        stopping.resolve();
        await resume.promise;
      }
      this.status.asr = 'stopped';
    },
  };
  const broker = await runBroker(f.root, { owner, identify: f.identify });
  const client = new LocalSpeechProcesses(f.root, {
    identify: f.identify,
    spawnImpl: () => assert.fail('the fixture broker must be reused'),
  });
  t.after(async () => {
    resume.resolve();
    await client.close();
    await broker.close();
    f.clean();
  });
  const release = broker.leases.release.bind(broker.leases);
  t.mock.method(broker.leases, 'release', id => {
    release(id);
    disconnected.resolve();
  });
  client.start(f.services);
  await client.ready('asr', 1000);
  assert.deepEqual(starts, [8000]);

  f.save({ asr: { ...f.services.asr, port: 8911 } });
  const reconfigure = client.request('configure').catch(error => error.message);
  await stopping.promise;
  try {
    await client.close();
    await disconnected.promise;
  } finally {
    resume.resolve();
  }
  assert.equal(await reconfigure, 'LOCAL_SPEECH_DISCONNECTED');
  await delay(0);
  assert.deepEqual(starts, [8000]);
  assert.equal(owner.status.asr, 'stopped');
});

test('speech reconfiguration starts the latest saved service after the previous one stops', async t => {
  const f = speechBrokerFixture();
  const stopping = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const starts = [];
  const owner = {
    status: {},
    start(services) {
      starts.push(services.asr.port);
      this.status.asr = 'ready';
    },
    async close(kind) {
      if (kind === 'asr') {
        stopping.resolve();
        await resume.promise;
      }
      this.status.asr = 'stopped';
    },
  };
  const broker = await runBroker(f.root, { owner, identify: f.identify });
  const client = new LocalSpeechProcesses(f.root, {
    identify: f.identify,
    spawnImpl: () => assert.fail('the fixture broker must be reused'),
  });
  t.after(async () => {
    resume.resolve();
    await client.close();
    await broker.close();
    f.clean();
  });
  client.start(f.services);
  await client.ready('asr', 1000);
  assert.deepEqual(starts, [8000]);

  f.save({ asr: { ...f.services.asr, port: 8911 } });
  const reconfigure = client.request('configure');
  try {
    await Promise.race([stopping.promise, reconfigure]);
    f.save({ asr: { ...f.services.asr, port: 8912 } });
  } finally {
    resume.resolve();
  }
  assert.equal((await reconfigure).asr, 'ready');
  assert.deepEqual(starts, [8000, 8912]);
});

for (const recover of [true, false]) {
  test('speech startup retries an exited broker once, recover=' + recover, async t => {
    const f = speechBrokerFixture();
    const restarted = Promise.withResolvers();
    let launches = 0;
    let readyBroker;
    const owner = {
      status: {},
      start({ asr }) {
        if (asr) this.status.asr = 'ready';
      },
      async close() {
        this.status.asr = 'stopped';
      },
    };
    const client = new LocalSpeechProcesses(f.root, {
      identify: f.identify,
      spawnImpl() {
        launches++;
        const child = Object.assign(new EventEmitter(), { unref() {} });
        if (launches === 2) restarted.resolve();
        if (launches === 2 && recover) readyBroker = runBroker(f.root, { owner, identify: f.identify });
        else queueMicrotask(() => child.emit('close', 1));
        return child;
      },
    });
    t.after(async () => {
      await client.close();
      await (await readyBroker)?.close();
      f.clean();
    });
    client.start(f.services);
    assert.equal(await Promise.race([restarted.promise.then(() => true), delay(1500, false, { ref: false })]), true);
    if (recover) {
      await client.ready('asr', 1000);
      assert.equal(owner.status.asr, 'ready');
    } else {
      await delay(350);
    }
    assert.equal(launches, 2);
  });
}

test('invalid optional configuration does not launch any child', () => {
  const manager = new LocalSpeechProcesses(os.tmpdir(), {
    spawnImpl() {
      throw Error('must not spawn');
    },
  });
  assert.deepEqual(manager.start({ tts: { enabled: true, python: '' } }), { tts: 'failed' });
});

test('model control follows current speech settings and binds loads to the requesting service', async t => {
  const f = speechBrokerFixture();
  const calls = [];
  const servers = [];
  const alias = path.join(f.root, 'model-client-workspace');
  let broker, client;
  t.after(async () => {
    await client?.close();
    await broker?.close();
    for (const server of servers) {
      server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
    if (fs.lstatSync(alias, { throwIfNoEntry: false })?.isSymbolicLink()) fs.rmSync(alias, { force: true });
    f.clean();
  });
  const host = async name => {
    const server = http.createServer((request, response) => {
      calls.push([name, request.method, request.url]);
      request.resume();
      response.end(JSON.stringify({ version: 1, name }));
    });
    servers.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return server.address().port;
  };
  const original = { asr: { ...f.services.asr, port: await host('original') } };
  const replacement = { asr: { ...f.services.asr, port: await host('replacement') } };
  f.save(original);
  fs.mkdirSync(path.join(f.root, 'state/local-speech'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'state/local-speech/asr.control.key'), 'x'.repeat(32));
  fs.writeFileSync(path.join(f.root, 'state/local-speech/asr.profiles.json'), '{}');
  fs.symlinkSync(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const owner = {
    status: {},
    start({ asr }) {
      if (asr) this.status.asr = 'ready';
    },
    async close() {
      this.status.asr = 'stopped';
    },
  };
  broker = await runBroker(f.root, { owner, identify: f.identify });
  client = new LocalSpeechProcesses(alias, {
    identify: f.identify,
    spawnImpl: () => assert.fail('the fixture broker must be reused'),
  });
  client.start(original);
  await client.ready('asr', 1000);
  assert.equal((await client.modelStatus('asr')).name, 'original');

  f.save(replacement);
  assert.equal((await client.modelStatus('asr')).name, 'replacement');
  const body = { profile: 'fixture', revision: 'profile-revision' };
  await assert.rejects(client.model('asr', 'load', body), /LOCAL_MODEL_REVISION_CHANGED/);
  client.start(replacement);
  assert.equal((await client.model('asr', 'load', body)).name, 'replacement');

  const waiting = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const ready = client.ready.bind(client);
  const held = t.mock.method(client, 'ready', async (...args) => {
    waiting.resolve();
    await resume.promise;
    return ready(...args);
  });
  const pending = client.model('asr', 'load', body);
  const rejected = assert.rejects(pending, /LOCAL_MODEL_REVISION_CHANGED/);
  try {
    await Promise.race([waiting.promise, rejected]);
    f.save(original);
    client.start(original);
  } finally {
    resume.resolve();
    held.mock.restore();
    await rejected;
  }

  f.save({});
  await assert.rejects(client.modelStatus('asr'), /LOCAL_SPEECH_NOT_ENABLED/);
  assert.deepEqual(calls, [
    ['original', 'GET', '/wca/status'],
    ['replacement', 'GET', '/wca/status'],
    ['replacement', 'POST', '/wca/load'],
  ]);
});

test('the speech broker cancels model loads with an obsolete service or requester', { timeout: 15000 }, async t => {
  const temporary = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporary, 'speech-model-cancel-'));
  const requests = new Map();
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const { profile } = JSON.parse(raw);
    const disconnected = Promise.withResolvers();
    response.once('close', () => {
      if (!response.writableFinished) disconnected.resolve(true);
    });
    requests.get(profile).resolve({
      disconnected: disconnected.promise,
      finish() {
        if (!response.destroyed)
          response.end(JSON.stringify({ version: 1, loaded: true, selectedProfile: profile, loadedProfile: profile }));
      },
    });
  });
  let broker, desktop, adapter;
  t.after(async () => {
    await desktop?.close();
    await adapter?.close();
    await broker?.close();
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    const actual = fs.realpathSync(root);
    assert.equal(path.dirname(actual), temporary);
    assert.match(path.basename(actual), /^speech-model-cancel-[a-z0-9]+$/i);
    fs.rmSync(actual, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const python = path.join(root, 'python.exe');
  fs.writeFileSync(python, '');
  fs.mkdirSync(path.join(root, 'config'));
  fs.mkdirSync(path.join(root, 'state/local-speech'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state/local-speech/tts.control.key'), 'x'.repeat(32));
  const asr = { enabled: true, python, modelDirectory: root };
  const tts = { ...asr, port: server.address().port };
  const save = localSpeech =>
    fs.writeFileSync(path.join(root, 'config/wechatagent.json'), JSON.stringify({ runtime: { localSpeech } }));
  save({ asr, tts });
  const identity = { pid: process.pid, created: 'fixture-creation' };
  const identify = async pid => (pid === process.pid ? identity : null);
  const waitForDisconnect = request => Promise.race([request.disconnected, delay(2000, false, { ref: false })]);
  const starts = [];
  let stopping, firstStop, disconnectedBeforeStop, pendingStop;
  const owner = {
    status: {},
    start(services) {
      for (const kind of Object.keys(services)) {
        this.status[kind] = 'ready';
        starts.push(kind);
      }
    },
    async close(kind) {
      if (kind && stopping) {
        firstStop = kind;
        disconnectedBeforeStop = await waitForDisconnect(stopping);
        stopping.finish();
        stopping = null;
      }
      if (kind && pendingStop) {
        const stop = pendingStop;
        pendingStop = null;
        stop.entered.resolve();
        await stop.release.promise;
      }
      for (const key of kind ? [kind] : Object.keys(this.status)) this.status[key] = 'stopped';
    },
  };
  broker = await runBroker(root, { owner, identify });
  const client = () =>
    new LocalSpeechProcesses(root, {
      identify,
      spawnImpl() {
        assert.fail('the fixture broker must be reused');
      },
    });
  desktop = client();
  adapter = client();
  desktop.start({ asr, tts });
  adapter.start({ asr, tts });
  await Promise.all([desktop.ready('tts', 1000), adapter.ready('tts', 1000)]);
  const load = (manager, profile) => {
    const started = Promise.withResolvers();
    requests.set(profile, started);
    const result = manager.model('tts', 'load', { profile, revision: 'fixture' }).catch(error => error.message);
    return { result, started: started.promise };
  };

  await t.test('configuration changes abort the old load before stopping its service', async () => {
    const stale = load(desktop, 'old-settings');
    stopping = await stale.started;
    const modelDirectory = path.join(root, 'new-models');
    const changed = { asr: { ...asr, modelDirectory }, tts: { ...tts, modelDirectory } };
    save(changed);
    desktop.start(changed);
    adapter.start(changed);
    await Promise.all([desktop.ready('tts', 1000), adapter.ready('tts', 1000)]);
    assert.equal(firstStop, 'asr');
    assert.equal(disconnectedBeforeStop, true);
    assert.equal(await stale.result, 'LOCAL_MODEL_REVISION_CHANGED');
  });

  await t.test('closing a requester aborts its load while a peer can complete one', async () => {
    const departed = load(desktop, 'departed');
    const peer = load(adapter, 'peer');
    const [departedRequest, peerRequest] = await Promise.all([departed.started, peer.started]);
    await desktop.close();
    assert.equal(await waitForDisconnect(departedRequest), true);
    assert.equal(await departed.result, 'LOCAL_SPEECH_DISCONNECTED');
    assert.equal(owner.status.tts, 'ready');
    peerRequest.finish();
    assert.equal((await peer.result).loadedProfile, 'peer');
  });

  await t.test('shutting down during reconfiguration leaves both services stopped', async () => {
    const snapshot = [...starts];
    const stop = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
    pendingStop = stop;
    save({ asr, tts });
    const reconfigure = adapter.request('configure').catch(error => error.message);
    try {
      await stop.entered.promise;
      await broker.close();
      assert.equal(await reconfigure, 'LOCAL_SPEECH_DISCONNECTED');
    } finally {
      stop.release.resolve();
    }
    await delay(0);
    assert.deepEqual(starts, snapshot);
    assert.deepEqual(owner.status, { asr: 'stopped', tts: 'stopped' });
  });
});

test('actual host process identity includes stable creation time', async () => {
  const first = await processIdentity(process.pid),
    second = await processIdentity(process.pid);
  assert.ok(first && /^\d+$/.test(first.created));
  assert.equal(sameProcess(first, second), true);
  assert.equal(sameProcess(first, { ...first, created: first.created + '0' }), false);
});

test('invalid synthesis settings leave a configured recognition service available', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-isolation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const python = path.join(root, 'python.exe');
  fs.writeFileSync(python, 'fixture');
  const status = {};
  const services = normalizeServices(
    root,
    {
      asr: { enabled: true, python, modelDirectory: root },
      tts: {
        enabled: true,
        python: path.join(root, 'missing', 'python.exe'),
        profiles: 'voices.json',
        modelDirectory: root,
      },
    },
    status,
  );
  assert.deepEqual(Object.keys(services), ['asr']);
  assert.deepEqual(status, { tts: 'failed' });
});
