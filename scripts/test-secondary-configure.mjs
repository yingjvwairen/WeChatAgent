import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { configureSecondary } from './configure-secondary.mjs';

test('a fresh secondary machine can import its own runtime and model profiles in one atomic configuration', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'secondary-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'));
  fs.copyFileSync(
    new URL('../config/wechatagent.example.json', import.meta.url),
    path.join(root, 'config/wechatagent.example.json'),
  );
  const asset = name => {
    const file = path.join(root, name);
    fs.writeFileSync(file, 'fixture');
    return file;
  };
  const python = asset('python.exe'),
    version = '4.2.0.53';
  const settings = {
    runtime: {
      python,
      dshDesktop: asset('DSH.exe'),
      localSpeech: {
        tts: {
          python,
          modelDirectory: root,
          profiles: {
            voice: {
              gptWeights: asset('voice.ckpt'),
              sovitsWeights: asset('voice.pth'),
              refAudio: asset('ref.wav'),
              promptText: 'test',
              promptLang: 'zh',
              textLang: 'zh',
            },
          },
        },
      },
    },
    input: { wechatExecutable: asset('Weixin.exe'), controlMode: 'uia' },
  };
  const inspect = async ({ executable }) => ({ path: executable, version });
  const bad = structuredClone(settings);
  bad.runtime.localSpeech.tts.profiles.voice.gptWeights = 'missing.ckpt';
  await assert.rejects(configureSecondary(root, bad, inspect));
  assert.equal(fs.existsSync(path.join(root, 'config/wechatagent.json')), false);
  const [first, again] = await Promise.all([
    configureSecondary(root, settings, inspect),
    configureSecondary(root, settings, inspect),
  ]);
  assert.deepEqual(first, again);
  const config = JSON.parse(fs.readFileSync(first.file, 'utf8'));
  assert.deepEqual(config.wechat.whitelist, { private: [], groups: [] });
  assert.equal(config.input.controlMode, 'uia');
  const file = path.join(root, config.runtime.localSpeech.tts.profiles);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).voice.promptText, 'test');
  settings.input.controlMode = 'ocr';
  await assert.rejects(configureSecondary(root, settings, inspect), /已有不同/);
  assert.equal(JSON.parse(fs.readFileSync(first.file, 'utf8')).input.controlMode, 'uia');
});
