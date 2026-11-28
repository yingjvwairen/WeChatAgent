import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { SpeechLeases } from './local-speech-leases.mjs';
import { LocalSpeechProcesses } from './local-speech-processes.mjs';
import { runBroker, normalizeServices } from './local-speech-broker.mjs';
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

test('real local IPC shares one owned service and the last disconnection releases it', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-owner-'));
  const python = path.join(root, 'python.exe');
  fs.writeFileSync(python, '');
  const identity = { pid: process.pid, created: 'fixture-creation' },
    identify = async pid => (pid === process.pid ? identity : null);
  let starts = 0,
    stops = 0;
  const owner = {
    status: {},
    start(services) {
      for (const kind of Object.keys(services)) {
        starts++;
        this.status[kind] = 'ready';
      }
    },
    async close(kind) {
      for (const key of kind ? [kind] : Object.keys(this.status))
        if (this.status[key] === 'ready') {
          stops++;
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
  const services = { asr: { enabled: true, python, modelDirectory: root } };
  fs.mkdirSync(path.join(root, 'config'));
  const save = localSpeech =>
    fs.writeFileSync(path.join(root, 'config/wechatagent.json'), JSON.stringify({ runtime: { localSpeech } }));
  save(services);
  desktop.start(services);
  adapter.start(services);
  await Promise.all([desktop.ready('asr', 1000), adapter.ready('asr', 1000)]);
  assert.equal(starts, 1);
  assert.equal(broker.leases.clients.size, 2);
  const changed = { asr: { ...services.asr, port: 8102 } };
  save(changed);
  desktop.start(changed);
  adapter.start(services);
  await Promise.all([desktop.ready('asr', 1000), adapter.ready('asr', 1000)]);
  assert.equal(starts, 2);
  assert.equal(stops, 1);
  await desktop.close();
  await delay(30);
  assert.equal(stops, 1);
  assert.equal(broker.leases.clients.size, 1);
  await adapter.close();
  await delay(30);
  assert.equal(stops, 2);
  assert.equal(broker.leases.clients.size, 0);
});

test('invalid optional configuration does not launch any child', () => {
  const manager = new LocalSpeechProcesses(os.tmpdir(), {
    spawnImpl() {
      throw Error('must not spawn');
    },
  });
  assert.deepEqual(manager.start({ tts: { enabled: true, python: '' } }), { tts: 'failed' });
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
