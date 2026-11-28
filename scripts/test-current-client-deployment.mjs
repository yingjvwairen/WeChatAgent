import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import deployment from '../apps/console-desktop/deployment.cjs';
import { BUNDLED_PLUGINS } from '../packages/plugin-api/bundled.mjs';
import { desktopManifest, seedDesktopPayloads } from './test-fixtures/desktop-deployment.mjs';
import { archivePlugin, configuration, pluginCatalog } from '../packages/plugin-api/catalog.mjs';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wechatagent-desktop-release-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const resources = path.join(base, 'resources'),
    home = path.join(base, 'data');
  const write = (relative, value) => {
    const file = path.join(resources, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  const manifest = desktopManifest({
    version: '0.4.5',
    buildId: 'fixture',
    files: ['config/wechatagent.example.json'],
  });
  write(
    'project/config/wechatagent.example.json',
    JSON.stringify({
      runtime: { sender: 'wechat-ui', python: 'python', dshDesktop: '' },
      input: { wechatExecutable: '', controlMode: 'ocr' },
      wechat: { whitelist: { private: [], groups: [] } },
      persona: { default: 'example', chats: {} },
    }),
  );
  write('project/deployment.json', JSON.stringify(manifest));
  seedDesktopPayloads(write);
  return { resources, home, write, manifest };
}
test('desktop deployment bundles runtimes and verified native tools without selecting or redistributing WeChat', async t => {
  const f = fixture(t),
    installed = await deployment.bootstrapDeployment(f.resources, f.home);
  const config = JSON.parse(fs.readFileSync(path.join(installed.root, 'config/wechatagent.json'))),
    distribution = JSON.parse(fs.readFileSync(path.join(installed.root, 'config/distribution.json')));
  assert.equal(config.runtime.sender, 'wechat-ui');
  assert.equal(config.input.wechatExecutable, '');
  assert.equal(config.input.expectedVersion, '4.2.0.53');
  const profile = JSON.parse(fs.readFileSync(path.join(installed.root, 'release-profile.json')));
  assert.equal(config.input.expectedVersion, profile.wechatVersion);
  assert.equal(distribution.wechatVersion, profile.wechatVersion);
  assert.equal(distribution.desktopRuntime, true);
  assert.deepEqual(distribution.bundledWechatVersions, []);
  assert.equal(distribution.dshBundled, false);
  assert.ok(fs.existsSync(distribution.ocrPython));
  assert.ok(fs.existsSync(path.join(installed.root, 'state/ui-host/WechatQtActions.exe')));
  assert.ok(!fs.existsSync(path.join(installed.root, 'state/hook')));
  assert.ok(!fs.existsSync(path.join(f.resources, 'vendor')));
});
test('desktop upgrades preserve user program selection, persona, targets, and local plugin grants', async t => {
  const f = fixture(t),
    first = await deployment.bootstrapDeployment(f.resources, f.home),
    file = path.join(first.root, 'config/wechatagent.json');
  const config = JSON.parse(fs.readFileSync(file));
  config.input.wechatExecutable = 'D:/Applications/Weixin.exe';
  config.runtime.dshDesktop = 'D:/Applications/Harness.exe';
  config.wechat.whitelist.private = ['123'];
  config.persona.default = 'custom';
  fs.writeFileSync(file, JSON.stringify(config));
  f.manifest.version = '0.4.6';
  f.manifest.buildId = 'second';
  f.write('project/deployment.json', JSON.stringify(f.manifest));
  await deployment.bootstrapDeployment(f.resources, f.home);
  const next = JSON.parse(fs.readFileSync(file));
  assert.equal(next.input.wechatExecutable, config.input.wechatExecutable);
  assert.equal(next.runtime.dshDesktop, config.runtime.dshDesktop);
  assert.deepEqual(next.wechat.whitelist.private, ['123']);
  assert.equal(next.persona.default, 'custom');
  assert.equal(JSON.parse(fs.readFileSync(path.join(first.root, 'state/console-state.json'))).pendingApply, true);
});
test('wrong client manifests and corrupted native executables are rejected', async t => {
  const f = fixture(t);
  const expectedVersion = f.manifest.wechatVersion;
  f.manifest.wechatVersion = '4.2.0.12';
  f.write('project/deployment.json', JSON.stringify(f.manifest));
  await assert.rejects(deployment.bootstrapDeployment(f.resources, f.home), /版本无效/);
  f.manifest.wechatVersion = expectedVersion;
  f.manifest.bundledWechatVersions = ['4.2.0.53'];
  f.write('project/deployment.json', JSON.stringify(f.manifest));
  await assert.rejects(deployment.bootstrapDeployment(f.resources, f.home), /版本无效/);
  f.manifest.bundledWechatVersions = [];
  f.write('project/deployment.json', JSON.stringify(f.manifest));
  f.write('desktop-native/WechatQtActions.exe', 'changed');
  await assert.rejects(deployment.bootstrapDeployment(f.resources, f.home), /校验失败/);
});
test('fresh installs offer one voice plugin and upgrades preserve the old independent recognizer', async t => {
  const f = fixture(t),
    id = 'speech-recognition',
    dialogue = BUNDLED_PLUGINS.find(item => item.id === 'speech-synthesis');
  f.manifest.builtinPlugins = BUNDLED_PLUGINS.filter(item => item.builtin).map(item => item.id);
  const files = Object.fromEntries(
    [id, dialogue.id].flatMap(plugin =>
      ['plugin.json', 'index.mjs'].map(relative => {
        const file = 'optional-extensions/' + plugin + '/' + relative;
        return [file, fs.readFileSync(file)];
      }),
    ),
  );
  f.manifest.files.push(...Object.keys(files));
  f.manifest.sourceHashes = Object.fromEntries(Object.entries(files).map(([file, bytes]) => [file, hash(bytes)]));
  for (const [file, bytes] of Object.entries(files)) f.write('project/' + file, bytes);
  f.write('project/deployment.json', JSON.stringify(f.manifest));
  const fresh = await deployment.bootstrapDeployment(f.resources, f.home);
  const plugins = pluginCatalog(fresh.root).plugins;
  assert.deepEqual(
    plugins.map(({ id, version, builtin, enabled, permissions, chats }) => ({
      id,
      version,
      builtin,
      enabled,
      permissions,
      chats,
    })),
    [{ id: dialogue.id, version: dialogue.version, builtin: true, enabled: false, permissions: [], chats: [] }],
  );
  assert.equal(fs.existsSync(path.join(fresh.root, 'config/plugins.json')), false);
  assert.equal(fs.existsSync(path.join(fresh.root, 'plugins', id)), false);
  assert.throws(() => archivePlugin(fresh.root, dialogue.id, configuration(fresh.root).revision), /内置/);
  const priorHome = path.join(f.home, 'upgrade'),
    priorRoot = path.join(priorHome, 'workspace'),
    priorPlugin = path.join(priorRoot, 'plugins', id);
  fs.mkdirSync(priorPlugin, { recursive: true });
  const oldPackage = { ...JSON.parse(files['optional-extensions/' + id + '/plugin.json']), version: '1.5.0' };
  fs.writeFileSync(path.join(priorPlugin, 'plugin.json'), JSON.stringify(oldPackage));
  fs.writeFileSync(path.join(priorPlugin, 'index.mjs'), '// existing plugin');
  fs.mkdirSync(path.join(priorRoot, 'config'));
  fs.writeFileSync(path.join(priorRoot, 'config/distribution.json'), JSON.stringify({ builtinPlugins: [id] }));
  const existingSettings = {
    version: 1,
    plugins: {
      [id]: {
        enabled: true,
        permissions: ['audio_read'],
        chats: ['wechat:private:123'],
        settings: { apiKey: 'fixture-key' },
      },
    },
  };
  fs.writeFileSync(path.join(priorRoot, 'config/plugins.json'), JSON.stringify(existingSettings));
  await deployment.bootstrapDeployment(f.resources, priorHome);
  assert.equal(fs.readFileSync(path.join(priorPlugin, 'index.mjs'), 'utf8'), '// existing plugin');
  assert.deepEqual(configuration(priorRoot).config, existingSettings);
  assert.deepEqual(
    pluginCatalog(priorRoot).plugins.map(({ id, version, builtin, enabled }) => ({ id, version, builtin, enabled })),
    [
      { id, version: '1.5.0', builtin: false, enabled: true },
      { id: dialogue.id, version: dialogue.version, builtin: true, enabled: false },
    ],
  );
});

test('updating a verified bundled copy preserves grants and archives its old code', async t => {
  const f = fixture(t),
    id = 'speech-recognition',
    prefix = 'optional-extensions/' + id + '/';
  f.manifest.builtinPlugins = [id];
  const publish = (version, code) => {
    const files = {
      [prefix + 'plugin.json']: JSON.stringify({ id, name: 'Fixture', host: 'wechatagent', apiVersion: 2, version }),
      [prefix + 'index.mjs']: code,
    };
    f.manifest.files = ['release-profile.json', 'config/wechatagent.example.json', ...Object.keys(files)];
    f.manifest.sourceHashes = Object.fromEntries(Object.entries(files).map(([name, value]) => [name, hash(value)]));
    for (const [name, value] of Object.entries(files)) f.write('project/' + name, value);
    f.write('project/deployment.json', JSON.stringify(f.manifest));
  };
  publish('1.6.0', '// old');
  const { root } = await deployment.bootstrapDeployment(f.resources, f.home);
  const target = path.join(root, 'plugins', id),
    prefs = path.join(root, 'config/plugins.json');
  const settings = JSON.stringify({
    version: 1,
    plugins: { [id]: { enabled: true, chats: ['wechat:private:123'], permissions: ['audio_read'] } },
  });
  fs.writeFileSync(prefs, settings);
  const distributionFile = path.join(root, 'config/distribution.json');
  const previous = JSON.parse(fs.readFileSync(distributionFile));
  delete previous.builtinPluginHashes;
  fs.writeFileSync(distributionFile, JSON.stringify(previous));
  publish('1.7.0', '// segmented');
  await deployment.bootstrapDeployment(f.resources, f.home);
  assert.equal(fs.readFileSync(path.join(target, 'index.mjs'), 'utf8'), '// segmented');
  assert.equal(fs.readFileSync(prefs, 'utf8'), settings);
  const archives = path.join(root, 'state/plugin-archives');
  assert.equal(fs.readFileSync(path.join(archives, fs.readdirSync(archives)[0], 'index.mjs'), 'utf8'), '// old');
  await deployment.bootstrapDeployment(f.resources, f.home);
  assert.equal(fs.readdirSync(archives).length, 1);
  fs.writeFileSync(path.join(target, 'local-customization.txt'), 'keep');
  publish('1.8.0', '// next');
  await deployment.bootstrapDeployment(f.resources, f.home);
  assert.equal(fs.readFileSync(path.join(target, 'index.mjs'), 'utf8'), '// segmented');
  assert.equal(fs.readFileSync(path.join(target, 'local-customization.txt'), 'utf8'), 'keep');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'config/distribution.json'))).builtinPlugins, []);
});

test('an unsupported data directory is rejected before any project or runtime file is copied', async t => {
  const f = fixture(t),
    root = path.join(f.home, 'workspace'),
    config = path.join(root, 'config/wechatagent.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const original = JSON.stringify({ runtime: { sender: 'wechat-hook' } });
  fs.writeFileSync(config, original);
  await assert.rejects(deployment.bootstrapDeployment(f.resources, f.home), /新的数据目录/);
  assert.equal(fs.readFileSync(config, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(root), ['config']);
  assert.deepEqual(fs.readdirSync(f.home), ['workspace']);
});
