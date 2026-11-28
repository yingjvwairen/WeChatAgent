import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLocalModelControls, discoverModels, validateProfiles } from './local-model-profiles.mjs';
import { LocalSpeechProcesses } from './local-speech-processes.mjs';
import { profileEditorHtml, localModelSettings } from '../public/console/local-model-settings.mjs';
import { createLocalModelDrafts, modelDefaults } from '../public/console/local-model-schema.mjs';
import { createConsole } from './console-server.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-profiles-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['one.ckpt', 'one.pth', 'ref.wav', 'model.bin', 'tokenizer.json', 'config.json'])
    fs.writeFileSync(path.join(root, name), 'fixture');
  return root;
}

test('the console serves the shared JSON schema with a JSON module content type', async t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'config'));
  fs.copyFileSync(
    new URL('../config/wechatagent.example.json', import.meta.url),
    path.join(root, 'config/wechatagent.json'),
  );
  const app = createConsole({ root, port: 0 });
  t.after(() => app.close());
  const address = await app.start();
  const response = await fetch(`http://127.0.0.1:${address.port}/packages/speech-contract/local-model-fields.json`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  const schema = await response.json();
  assert.equal(schema.tts.find(field => field.key === 'speed').default, modelDefaults('tts').speed);
  assert.equal(schema.speechLimits.maxReplyChars, 4000);
});

test('the selected profile cannot disappear from disk while the service keeps using it', async t => {
  const root = fixture(t);
  const config = { runtime: { localSpeech: { asr: { enabled: true, modelDirectory: root } } } };
  const controls = createLocalModelControls({
    root,
    readConfig: () => config,
    manager: { status: {}, start() {}, close() {} },
  });
  const profiles = { first: { modelDirectory: root }, second: { modelDirectory: root } };
  const saved = await controls.saveProfiles({ kind: 'asr', profiles, revision: (await controls.view()).asr.revision });
  assert.equal(saved.asr.selectedProfile, 'first');
  assert.throws(
    () => controls.saveProfiles({ kind: 'asr', profiles: { second: profiles.second }, revision: saved.asr.revision }),
    /SELECTED_PROFILE_REQUIRED/,
  );
  assert.deepEqual(Object.keys((await controls.view()).asr.profiles), ['first', 'second']);
  fs.writeFileSync(path.join(root, 'state/local-speech/asr.selection.json'), JSON.stringify({ profile: 'second' }));
  const next = await controls.saveProfiles({
    kind: 'asr',
    profiles: { second: profiles.second },
    revision: saved.asr.revision,
  });
  assert.equal(next.asr.selectedProfile, 'second');
});

for (const kind of ['asr', 'tts'])
  test(`a released ${kind} service can save the selection for the next local route`, async t => {
    const root = fixture(t);
    const config = { runtime: { localSpeech: { [kind]: { enabled: true, modelDirectory: root } } } };
    const controls = createLocalModelControls({
      root,
      readConfig: () => config,
      manager: {
        status: { [kind]: 'standby' },
        start() {},
        model: () => assert.fail('The local model stays released'),
        close() {},
      },
    });
    const profile =
      kind === 'asr'
        ? { modelDirectory: root }
        : { gptWeights: 'one.ckpt', sovitsWeights: 'one.pth', refAudio: 'ref.wav', promptLang: 'zh', textLang: 'zh' };
    const profiles = { first: profile, second: profile };
    const saved = await controls.saveProfiles({ kind, profiles, revision: (await controls.view())[kind].revision });
    const result = await controls.use({ kind, profile: 'second', revision: saved[kind].revision });
    assert.equal(result.loaded.phase, 'standby');
    assert.equal(result[kind].selectedProfile, 'second');
    assert.equal(result[kind].loadedProfile, null);
  });

test('model drafts survive page replacement and failed saves with their original revision', async () => {
  const drafts = createLocalModelDrafts();
  drafts.set('tts', {
    id: 'voice',
    profile: { ...modelDefaults('tts'), name: 'edited' },
    saved: { revision: 'original', profiles: {} },
  });
  await assert.rejects(
    drafts.save(async () => {
      throw Error('revision conflict');
    }),
    /revision conflict/,
  );
  assert.equal(drafts.hasDraft(), true);
  assert.equal(drafts.get('tts').profile.name, 'edited');
  await drafts.save(async (route, body) => {
    assert.equal(route, '/api/local-models/profiles');
    assert.equal(body.revision, 'original');
    assert.equal(body.profiles.voice.name, 'edited');
  });
  assert.equal(drafts.hasDraft(), false);
});
test('named weights save with CAS and use waits for immediate loader acknowledgement', async t => {
  const root = fixture(t),
    config = { runtime: { localSpeech: { tts: { enabled: true, modelDirectory: root, port: 39881 } } } };
  let complete, requested;
  const manager = {
    status: { tts: 'ready' },
    start() {},
    async modelStatus() {
      return { phase: 'ready', loadedProfile: 'dania' };
    },
    model(kind, action, data) {
      requested = { kind, action, data };
      return new Promise(resolve => {
        complete = resolve;
      });
    },
    close() {},
  };
  const controls = createLocalModelControls({ root, readConfig: () => config, manager });
  const before = await controls.view(),
    rows = {
      dania: {
        name: '达妮娅',
        gptWeights: 'one.ckpt',
        sovitsWeights: 'one.pth',
        refAudio: 'ref.wav',
        promptLang: 'zh',
        textLang: 'zh',
      },
    };
  assert.equal(before.tts.endpoint, 'http://127.0.0.1:39881/v1');
  const saved = await controls.saveProfiles({ kind: 'tts', profiles: rows, revision: before.tts.revision });
  assert.equal(saved.tts.profiles.dania.refAudio, path.join(root, 'ref.wav'));
  assert.throws(
    () => controls.saveProfiles({ kind: 'tts', profiles: rows, revision: before.tts.revision }),
    /REVISION_CHANGED/,
  );
  let settled = false;
  const loading = controls.use({ kind: 'tts', profile: 'dania', revision: saved.tts.revision }).then(value => {
    settled = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(requested.action, 'load');
  complete({ loaded: true, selectedProfile: 'dania', loadedProfile: 'dania', revision: saved.tts.revision });
  assert.equal((await loading).loaded.phase, 'ready');
});
test('disabled provider cannot be loaded and failed acknowledgements stay failed', async t => {
  const root = fixture(t),
    config = { runtime: { localSpeech: { asr: { enabled: false, modelDirectory: root } } } };
  const manager = {
    status: {},
    start() {},
    async model() {
      return { loaded: false };
    },
    close() {},
  };
  const controls = createLocalModelControls({ root, readConfig: () => config, manager });
  const saved = await controls.saveProfiles({
    kind: 'asr',
    profiles: { zh: { name: '中文', modelDirectory: root, language: 'zh' } },
    revision: (await controls.view()).asr.revision,
  });
  await assert.rejects(controls.use({ kind: 'asr', profile: 'zh', revision: saved.asr.revision }), /NOT_ENABLED/);
  config.runtime.localSpeech.asr.enabled = true;
  await assert.rejects(controls.use({ kind: 'asr', profile: 'zh', revision: saved.asr.revision }), /LOAD_UNCONFIRMED/);
});

test('the console drops the prior model status as soon as the service is disabled', async t => {
  const root = fixture(t);
  const config = { runtime: { localSpeech: { asr: { enabled: true, modelDirectory: root } } } };
  let checks = 0;
  const manager = {
    status: { asr: 'ready' },
    start() {},
    async modelStatus() {
      checks++;
      return { phase: 'ready', loadedProfile: 'fixture', revision: 'fixture-revision' };
    },
  };
  const controls = createLocalModelControls({ root, readConfig: () => config, manager });
  assert.equal((await controls.view()).asr.loadedProfile, 'fixture');

  config.runtime.localSpeech.asr.enabled = false;
  const disabled = (await controls.view()).asr;
  assert.equal(disabled.phase, 'stopped');
  assert.equal(disabled.loadedProfile, null);
  assert.equal(checks, 1);
});

test('console reports the loaded model and clears readiness after a failed switch', async t => {
  const root = fixture(t);
  const config = { runtime: { localSpeech: { tts: { enabled: true, modelDirectory: root } } } };
  let state = { phase: 'ready', loadedProfile: 'voice' };
  const manager = {
    status: { tts: 'ready' },
    start() {},
    modelStatus: async () => state,
    async model() {
      state = { phase: 'failed', loadedProfile: null };
      throw Error('LOCAL_MODEL_LOAD_FAILED');
    },
  };
  const controls = createLocalModelControls({ root, readConfig: () => config, manager });
  const saved = await controls.saveProfiles({
    kind: 'tts',
    profiles: { voice: { gptWeights: 'one.ckpt', sovitsWeights: 'one.pth', refAudio: 'ref.wav' } },
    revision: (await controls.view()).tts.revision,
  });
  assert.equal(saved.tts.loadedProfile, 'voice');
  await assert.rejects(controls.use({ kind: 'tts', profile: 'voice', revision: saved.tts.revision }), /LOAD_FAILED/);
  const result = (await controls.view()).tts;
  assert.deepEqual([result.phase, result.loadedProfile], ['failed', null]);
});

for (const phase of ['standby', 'ready']) {
  test('activation rejects a service configuration changed while the broker was preparing, ' + phase, async t => {
    const root = fixture(t);
    const config = { runtime: { localSpeech: { asr: { enabled: true, modelDirectory: root, port: 39882 } } } };
    const startup = Promise.withResolvers();
    const manager = {
      status: { asr: phase },
      start() {},
      operation: startup.promise,
      modelStatus: async () => ({ phase }),
      model: () => assert.fail('the old settings must not invoke the new service'),
    };
    const controls = createLocalModelControls({ root, readConfig: () => config, manager });
    const saved = await controls.saveProfiles({
      kind: 'asr',
      profiles: { zh: { modelDirectory: root } },
      revision: (await controls.view()).asr.revision,
    });
    const activating = controls.use({ kind: 'asr', profile: 'zh', revision: saved.asr.revision });
    config.runtime.localSpeech.asr.port = 39883;
    startup.resolve();
    await assert.rejects(activating, /LOCAL_MODEL_REVISION_CHANGED/);
    assert.equal(fs.existsSync(path.join(root, 'state/local-speech/asr.selection.json')), false);
  });
}

test('activation rechecks configuration immediately before sending a load after model startup', async t => {
  const root = fixture(t);
  const config = { runtime: { localSpeech: { asr: { enabled: true, modelDirectory: root, port: 39882 } } } };
  const starting = Promise.withResolvers(),
    startup = Promise.withResolvers();
  const manager = new LocalSpeechProcesses(root);
  manager.start = () => {};
  manager.ready = async () => {
    starting.resolve();
    await startup.promise;
  };
  manager.request = () => assert.fail('a load must use the current service configuration');
  const controls = createLocalModelControls({ root, readConfig: () => config, manager });
  const saved = await controls.saveProfiles({
    kind: 'asr',
    profiles: { zh: { modelDirectory: root } },
    revision: (await controls.view()).asr.revision,
  });
  const activating = controls.use({ kind: 'asr', profile: 'zh', revision: saved.asr.revision });
  await Promise.race([starting.promise, activating.then(() => assert.fail('activation skipped model startup'))]);
  config.runtime.localSpeech.asr.port = 39883;
  startup.resolve();
  await assert.rejects(activating, /LOCAL_MODEL_REVISION_CHANGED/);
});

test('saving the same model ID reports pending settings until their revision is loaded', async t => {
  const root = fixture(t);
  const config = { runtime: { localSpeech: { asr: { enabled: true, modelDirectory: root } } } };
  let running;
  const manager = {
    status: {},
    start() {},
    modelStatus: async () => running,
    async model(_kind, _action, { profile, revision }) {
      running = { phase: 'ready', loadedProfile: profile, selectedProfile: profile, revision };
      return { ...running, loaded: true };
    },
  };
  const controls = createLocalModelControls({ root, readConfig: () => config, manager });
  const profiles = { zh: { name: '中文', modelDirectory: root, initialPrompt: '词表一' } };
  const original = await controls.saveProfiles({
    kind: 'asr',
    profiles,
    revision: (await controls.view()).asr.revision,
  });
  running = { phase: 'ready', loadedProfile: 'zh', selectedProfile: 'zh', revision: original.asr.revision };
  manager.status.asr = 'ready';
  assert.equal((await controls.view()).asr.phase, 'ready');

  profiles.zh.initialPrompt = '词表二';
  const saved = await controls.saveProfiles({ kind: 'asr', profiles, revision: original.asr.revision });
  assert.equal(saved.asr.phase, 'saved');
  assert.equal(saved.asr.loadedProfile, 'zh');
  assert.equal(saved.asr.loadedRevision, original.asr.revision);
  assert.notEqual(saved.asr.revision, saved.asr.loadedRevision);

  const applied = await controls.use({ kind: 'asr', profile: 'zh', revision: saved.asr.revision });
  assert.equal(applied.asr.phase, 'ready');
  assert.equal(applied.asr.loadedRevision, saved.asr.revision);
});
test('scanner finds local weights/reference audio and recognizers without executing anything', t => {
  const root = fixture(t),
    settings = { modelDirectory: root };
  const tts = discoverModels(root, 'tts', settings),
    asr = discoverModels(root, 'asr', settings);
  assert.equal(tts.candidates.gptWeights.length, 1);
  assert.equal(tts.candidates.sovitsWeights.length, 1);
  assert.equal(tts.candidates.refAudio.length, 1);
  assert.deepEqual(asr.candidates.modelDirectory, [root]);
  assert.throws(() =>
    validateProfiles(root, 'tts', settings, {
      bad: { gptWeights: '../other.ckpt', sovitsWeights: 'one.pth', refAudio: 'ref.wav' },
    }),
  );
  assert.throws(
    () => validateProfiles(root, 'asr', settings, { bad: { modelDirectory: root, language: 'zh-CN' } }),
    /LANGUAGE/,
  );
  const row = {
    gptWeights: 'one.ckpt',
    sovitsWeights: 'one.pth',
    refAudio: 'ref.wav',
    speed: 1.4,
    topK: 25,
    textSplitMethod: 'cut4',
  };
  assert.equal(validateProfiles(root, 'tts', settings, { voice: row }).voice.speed, 1.4);
  assert.throws(() => validateProfiles(root, 'tts', settings, { voice: { ...row, topK: 1.5 } }), /PARAMETER/);
  assert.throws(() => validateProfiles(root, 'tts', settings, { voice: { ...row, speed: 3 } }), /PARAMETER/);
});

test('the ASR console scan finds the models installed by media:prepare', t => {
  const root = fixture(t);
  const managed = path.join(root, 'state/local-whisper/models');
  const installed = ['base', 'small', 'tiny'].map(name => path.join(managed, name));
  for (const directory of installed) {
    fs.mkdirSync(directory, { recursive: true });
    for (const name of ['model.bin', 'tokenizer.json', 'config.json'])
      fs.writeFileSync(path.join(directory, name), 'weights');
  }
  const config = { runtime: { localSpeech: { asr: { modelDirectory: installed[1] } } } };
  const controls = createLocalModelControls({
    root,
    readConfig: () => config,
    manager: { status: {}, start() {}, close() {} },
  });
  assert.deepEqual(controls.discover({ kind: 'asr' }).candidates.modelDirectory, installed);
  delete config.runtime.localSpeech.asr.modelDirectory;
  assert.deepEqual(controls.discover({ kind: 'asr' }).candidates.modelDirectory, installed);
});
test('editor escapes model names and provides distinct save/use, weights and ASR profiles', () => {
  const state = {
    profiles: { one: { name: '<script>' } },
    selectedProfile: 'one',
    endpoint: 'local',
    apiKeyFile: 'key',
  };
  const html = profileEditorHtml('tts', state, 'one', state.profiles.one, { gptWeights: ['x" onfocus="bad'] });
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('data-model-action="use"'));
  assert.ok(html.includes('data-model-field="sovitsWeights"'));
  assert.ok(profileEditorHtml('asr', state, 'one', {}).includes('data-model-field="initialPrompt"'));
  const settings = localModelSettings({ field: () => '', toggle: () => '' });
  assert.ok(settings.includes('应用启动后自动预热'));
  assert.ok(settings.includes('model-editor="asr"'));
});
