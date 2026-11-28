import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { normalizeServices } from './local-speech-broker.mjs';
import {
  OwnedSpeechProcesses as LocalSpeechProcesses,
  managedSpeechCommand,
  localSpeechPort,
} from './local-speech-owned.mjs';

test('enabled local models start once and shutdown closes only the owned child', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-speech-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const python = path.join(root, 'python.exe');
  fs.writeFileSync(python, '');
  const children = [];
  const manager = new LocalSpeechProcesses(root, (exe, args, options) => {
    assert.equal(exe, python);
    assert.deepEqual(args.slice(0, 6), [
      '-I',
      '-B',
      '-u',
      path.join(root, 'scripts/local-speech-host.py'),
      'asr',
      '--model-dir',
    ]);
    assert.equal(options.shell, false);
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stdin.once('finish', () => child.emit('close', 0));
    children.push(child);
    return child;
  });
  const settings = { asr: { enabled: true, python, modelDirectory: root }, tts: { enabled: false } };
  const status = manager.start(settings);
  manager.start(settings);
  assert.equal(children.length, 1);
  assert.equal(status.asr, 'starting');
  children[0].stdout.write('WECHATAGENT_LOCAL_SPEECH_READY\n');
  await nextTurn();
  assert.equal(status.asr, 'ready');
  await manager.close();
  assert.equal(status.asr, 'stopped');
  assert.equal(status.tts, undefined);
});

test('an unavailable interpreter fails one optional service without disabling the adapter', () => {
  const manager = new LocalSpeechProcesses(os.tmpdir());
  assert.deepEqual(manager.start({ asr: { enabled: true, python: '', modelDirectory: 'missing' } }), { asr: 'failed' });
});

test('independent speech ports reach the child and reject invalid ports before spawning', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-ports-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const python = path.join(root, 'python.exe');
  fs.writeFileSync(python, '');
  const { args } = managedSpeechCommand(root, 'asr', { python, modelDirectory: root, port: 39800 });
  assert.equal(args[args.indexOf('--port') + 1], '39800');
  const selected = managedSpeechCommand(root, 'asr', { python, modelDirectory: root, preload: 'second' });
  assert.equal(selected.args[selected.args.indexOf('--preload') + 1], 'second');
  assert.equal(localSpeechPort('asr'), 8000);
  assert.equal(localSpeechPort('tts'), 9881);
  for (const port of [0, 1023, 65536, 1.5, '39800'])
    assert.throws(() => localSpeechPort('tts', { port }), /PORT_INVALID/);
});

test('implicit Whisper follows the configured model directory until a named profile is saved', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-default-model-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const python = path.join(root, 'python.exe');
  fs.writeFileSync(python, '');
  const config = { asr: { enabled: true, python, modelDirectory: path.join(root, 'small') } };
  function command() {
    const { asr } = normalizeServices(root, config, {});
    return managedSpeechCommand(root, 'asr', asr).args.slice(5, 7);
  }
  assert.deepEqual(command(), ['--model-dir', path.join(root, 'small')]);
  config.asr.modelDirectory = path.join(root, 'base');
  assert.deepEqual(command(), ['--model-dir', path.join(root, 'base')]);
  const profiles = path.join(root, 'state/local-speech/asr.profiles.json');
  fs.mkdirSync(path.dirname(profiles), { recursive: true });
  fs.writeFileSync(profiles, JSON.stringify({ chinese: { modelDirectory: path.join(root, 'small') } }));
  assert.deepEqual(command(), ['--profiles', profiles]);
});
