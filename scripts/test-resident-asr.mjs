import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';
import {localAsrStatus, stopLocalAsr, useLocalAsr} from './local-asr-service.mjs';
import {readSpeechProviderView} from './speech-provider-settings.mjs';

const configFile = process.env.WECHATAGENT_TEST_MEDIA_CONFIG;
const scripts = import.meta.dirname;
const run = promisify(execFile);

test('an unverified or busy endpoint never reports successful unload', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-asr-'));
  const dir = path.join(root, 'state/media-processing/resident-asr');
  fs.mkdirSync(dir, {recursive:true});
  const file = path.join(dir, 'endpoint.json');
  let reset = false;
  const server = http.createServer((req, res) => {
    if (reset) return req.socket.destroy();
    res.writeHead(200, {'Content-Length':2});
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.unlinkSync(file);
    for (let at = dir; at !== path.dirname(root); at = path.dirname(at)) fs.rmdirSync(at);
  });
  fs.writeFileSync(file, JSON.stringify({port:server.address().port, secret:'a'.repeat(64), instanceId:'b'.repeat(32)}));
  await assert.rejects(stopLocalAsr({root}), e => e.status === 503);
  reset = true;
  await assert.rejects(stopLocalAsr({root}), e => e.status === 503);
});

const reader = `
import io, json, sys, time, types, wave
from pathlib import Path
scripts, root, index = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3])
sys.path.insert(0, str(scripts))
from wechat_av import MediaCatalog
with wave.open(str(scripts / 'fixtures/speech-service-test.wav')) as source:
    audio = io.BytesIO()
    with wave.open(audio, 'wb') as output:
        output.setparams(source.getparams())
        frames = source.readframes(source.getnframes())
        output.writeframes(bytes(len(frames)) if index == 4 else frames + b'\\0\\0' * (1600 * index))
catalog = MediaCatalog(types.SimpleNamespace(root=root), root)
started = time.monotonic()
result = catalog.process_bound_source(format(index, '064x'), 'wechat:private:123', audio.getvalue(), 'audio', lambda: None)
print(json.dumps({'elapsedMs': round((time.monotonic()-started)*1000), 'transcript': result['transcript']}))
`;

test('the prepared recognizer serves two concurrent Readers after one explicit load', {skip: !configFile, timeout: 210000}, async t => {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-asr-'));
  t.after(async () => {
    await stopLocalAsr({root});
    if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('wechat-asr-'))
      fs.rmSync(root, {recursive: true, force: true});
  });
  const setup = path.join(root, 'state/media-processing');
  const settings = path.join(root, 'state/runtime/speech-providers.json');
  for (const dir of [setup, path.dirname(settings), path.join(root, 'scripts')]) fs.mkdirSync(dir, {recursive: true});
  fs.copyFileSync(configFile, path.join(setup, 'config.json'));
  fs.copyFileSync(path.join(scripts, 'local-media-worker.py'), path.join(root, 'scripts/local-media-worker.py'));
  const saved = {version: 1, asr: {mode:'local', endpoint:'', model:'', protectedKey:'', localModelDirectory:config.modelDirectory},
    tts: {mode:'local', endpoint:'', model:'', voice:'', protectedKey:''}};
  fs.writeFileSync(settings, JSON.stringify(saved));
  const id = readSpeechProviderView({root, includeLocalModels:true}).asr.localProfileId;
  const use = {root, id, expectedVersion: 1};
  const read = async index => JSON.parse((await run(config.python, ['-I', '-B', '-X', 'utf8', '-c', reader, scripts, root, String(index)],
    {windowsHide:true, timeout:130000})).stdout);
  assert.equal((await localAsrStatus({root})).instanceId, null);
  assert.equal((await read(0)).transcript.code, 'MEDIA_ASR_PROFILE_NOT_LOADED');
  assert.equal((await localAsrStatus({root})).instanceId, null);
  const start = Date.now();
  const loaded = await useLocalAsr(use);
  const loadMs = Date.now() - start;
  assert.equal(loaded.profileId, id);
  assert.equal(loaded.loaded, true);
  assert.equal(loaded.reused, false);
  // Saving unrelated settings preserves loaded weights and the current process.
  saved.version++;
  saved.tts.voice = 'test';
  fs.writeFileSync(settings, JSON.stringify(saved));
  await assert.rejects(useLocalAsr(use), e => e.status === 409);
  await assert.rejects(stopLocalAsr(use), e => e.status === 409);
  const again = await useLocalAsr({...use, expectedVersion:saved.version});
  assert.equal(again.instanceId, loaded.instanceId);
  assert.equal(again.reused, true);
  const clips = await Promise.all([read(1), read(2)]);
  for (const clip of clips) {
    assert.equal(clip.transcript.status, 'ready', JSON.stringify(clip.transcript));
    assert.ok(clip.transcript.text.trim());
  }
  assert.equal((await localAsrStatus({root})).instanceId, loaded.instanceId);
  assert.equal((await read(4)).transcript.status, 'no_speech');
  const {pid} = JSON.parse(fs.readFileSync(path.join(setup, 'resident-asr/endpoint.json'), 'utf8'));
  let memory = '';
  if (process.platform === 'win32') {
    const {stdout} = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `[math]::Round((Get-Process -Id ${Number(pid)}).WorkingSet64 / 1MB)`], {windowsHide:true});
    memory = `; working set ${stdout.trim()} MiB`;
  }
  t.diagnostic(`load ${loadMs} ms; concurrent clip wall times ${clips.map(clip => clip.elapsedMs).join(', ')} ms${memory}`);
  await stopLocalAsr({...use, expectedVersion:saved.version});
  assert.equal((await localAsrStatus({root})).instanceId, null);
  assert.equal((await read(3)).transcript.code, 'MEDIA_ASR_PROFILE_NOT_LOADED');
  const restarting = useLocalAsr({...use, expectedVersion:saved.version});
  const shuttingDown = stopLocalAsr({root});
  assert.equal((await restarting).loaded, true);
  assert.equal((await shuttingDown).loaded, false);
  assert.equal((await localAsrStatus({root})).instanceId, null);
});
