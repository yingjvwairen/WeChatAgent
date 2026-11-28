import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { prepare, validateConfig, projectRoot } from './project-config.mjs';
const example = JSON.parse(fs.readFileSync(path.join(projectRoot, 'config', 'wechatagent.example.json'), 'utf8'));
validateConfig(example);
assert.deepEqual(example.wechat.whitelist, { groups: [], private: [] });
assert.throws(
  () => validateConfig({ ...example, ports: { ...example.ports, onebot: example.ports.weflow } }),
  /distinct/,
);
assert.throws(() => validateConfig({ ...example, persona: { default: '../bad' } }), /persona/);
assert.throws(() => validateConfig({ ...example, runtime: { ...example.runtime, sender: 'unavailable' } }), /sender/);
assert.throws(() => validateConfig({ ...example, input: { ...example.input, expectedVersion: '4.1.15.56' } }), {
  code: 'DESKTOP_VERSION_UNSUPPORTED',
});
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'WeChatAgent portable '));
try {
  fs.mkdirSync(path.join(fixture, 'config'));
  fs.mkdirSync(path.join(fixture, 'roles'));
  fs.mkdirSync(path.join(fixture, 'state'));
  const unsupportedFile = path.join(fixture, 'config', 'wechatagent.json');
  const previousConnection = path.join(fixture, 'state', 'akasha-config.json');
  const unsupportedConfig = JSON.stringify({ ...example, version: 1, ports: { ...example.ports, akasha: 12121 } });
  const previousSettings = JSON.stringify({ bot_wxid: 'wxid_fixture', access_token: 'fixture' });
  fs.writeFileSync(unsupportedFile, unsupportedConfig);
  fs.writeFileSync(previousConnection, previousSettings);
  assert.throws(() => prepare(fixture), /重新选择微信聊天/);
  assert.equal(fs.readFileSync(unsupportedFile, 'utf8'), unsupportedConfig);
  assert.equal(fs.readFileSync(previousConnection, 'utf8'), previousSettings);
  assert.equal(fs.existsSync(path.join(fixture, 'state', 'wechat-io-config.json')), false);
  fs.unlinkSync(unsupportedFile);
  fs.unlinkSync(previousConnection);
  fs.copyFileSync(
    path.join(projectRoot, 'config', 'wechatagent.example.json'),
    path.join(fixture, 'config', 'wechatagent.example.json'),
  );
  fs.writeFileSync(path.join(fixture, 'roles', `${example.persona.default}.md`), '# Test role');
  const fixturePlugin = path.join(fixture, 'packages/dsh-social-bridge-plugin');
  fs.mkdirSync(fixturePlugin, { recursive: true });
  for (const file of [
    'plugin-catalog.mjs',
    'work-modes.mjs',
    'assistant-preset.mjs',
    'image-input.mjs',
    'deadline.mjs',
    'local-policy.mjs',
  ])
    fs.copyFileSync(path.join(projectRoot, 'packages/dsh-social-bridge-plugin', file), path.join(fixturePlugin, file));
  for (const file of [
    'cordis.patch.yml',
    'native-context.mjs',
    'session-groups.mjs',
    'prompt-context.mjs',
    'member-memory.mjs',
    'member-memory-policy.mjs',
    'meme-library.mjs',
    'meme-library-policy.mjs',
    'model-search.mjs',
    'dsh-access.mjs',
    'file-tools.mjs',
    'file-storage.mjs',
    'file-transfers.mjs',
    'assistant-policy.mjs',
    'conversation-policy.mjs',
    'dsh-bundled.mjs',
    'sticker-pool-review.mjs',
    'dsh-migration.mjs',
    'dsh-search.mjs',
    'search-provider.mjs',
    'search-budget.mjs',
    'search-policy.mjs',
    'weather-query.mjs',
    'weather-source.mjs',
    'social-tool-policy.mjs',
    'social-tool-restrict.mjs',
    'context-policy.mjs',
    'history-policy.mjs',
    'history-store.mjs',
    'history-runtime.mjs',
    'native-quote-source.mjs',
    'usage-summary.mjs',
    'request-window.mjs',
  ])
    fs.copyFileSync(path.join(projectRoot, 'packages/dsh-social-bridge-plugin', file), path.join(fixturePlugin, file));
  for (const file of [
    'web-reader.mjs',
    'web-reader-policy.mjs',
    'web-reader-fetch.mjs',
    'web-reader-content.mjs',
    'web-reader-zxsj.mjs',
  ])
    fs.copyFileSync(path.join(projectRoot, 'packages/dsh-social-bridge-plugin', file), path.join(fixturePlugin, file));
  fs.cpSync(path.join(projectRoot, 'packages/dsh-social-bridge-plugin/skills'), path.join(fixturePlugin, 'skills'), {
    recursive: true,
  });
  for (const file of fs.readdirSync(path.join(projectRoot, 'packages/dsh-social-bridge-plugin')))
    if (file.endsWith('.mjs'))
      fs.copyFileSync(
        path.join(projectRoot, 'packages/dsh-social-bridge-plugin', file),
        path.join(fixturePlugin, file),
      );
  prepare(fixture);
  const firstPluginPatch = fs.readFileSync(path.join(fixturePlugin, 'cordis.patch.yml'), 'utf8');
  assert(firstPluginPatch.includes('file:///') && firstPluginPatch.includes('?wechatagent='));
  const assertPluginEntry = patch => {
    const match = /    - id: dsh-social-bridge-plugin\r?\n      name: ("[^"\r\n]+")/.exec(patch);
    assert(match, 'generated DSH configuration must contain the bridge plugin entry');
    const entry = new URL(JSON.parse(match[1]));
    assert.equal(
      fileURLToPath(entry),
      path.join(fixturePlugin, 'native-context.mjs'),
      'DSH must load the bridge entry, not a helper from the revision source list',
    );
    assert.match(entry.search, /^\?wechatagent=[a-f0-9]{16}$/);
    const restrict = /          - id: social-tool-restrict\r?\n            name: ("[^"\r\n]+")/.exec(patch);
    assert(restrict, 'the scoped tool guard must reload with the bridge revision');
    const guardEntry = new URL(JSON.parse(restrict[1]));
    assert.equal(fileURLToPath(guardEntry), path.join(fixturePlugin, 'social-tool-restrict.mjs'));
    assert.equal(guardEntry.search, entry.search);
  };
  assertPluginEntry(firstPluginPatch);
  fs.appendFileSync(path.join(fixturePlugin, 'search-policy.mjs'), '\n// fixture policy revision\n');
  prepare(fixture);
  const revisedPluginPatch = fs.readFileSync(path.join(fixturePlugin, 'cordis.patch.yml'), 'utf8');
  assertPluginEntry(revisedPluginPatch);
  assert.notEqual(
    firstPluginPatch,
    revisedPluginPatch,
    'policy changes must invalidate the loaded plugin module version',
  );
  assert(revisedPluginPatch.includes('id: social-tool-restrict'), 'safe tool restrictions must remain mounted');
  prepare(fixture);
  assert.equal(
    fs.readFileSync(path.join(fixturePlugin, 'cordis.patch.yml'), 'utf8'),
    revisedPluginPatch,
    'unchanged sources must preserve the module version',
  );
  fs.appendFileSync(path.join(fixturePlugin, 'meme-library.mjs'), '\n// fixture meme library revision\n');
  prepare(fixture);
  const memePluginPatch = fs.readFileSync(path.join(fixturePlugin, 'cordis.patch.yml'), 'utf8');
  assertPluginEntry(memePluginPatch);
  assert.notEqual(
    memePluginPatch,
    revisedPluginPatch,
    'meme library changes must invalidate the bridge revision without changing its entry',
  );
  fs.appendFileSync(path.join(fixturePlugin, 'native-quote-source.mjs'), '\n// fixture quote policy revision\n');
  prepare(fixture);
  const mediaPluginPatch = fs.readFileSync(path.join(fixturePlugin, 'cordis.patch.yml'), 'utf8');
  assertPluginEntry(mediaPluginPatch);
  assert.notEqual(
    mediaPluginPatch,
    memePluginPatch,
    'changes to a transitive quote helper must invalidate the bridge revision',
  );
  const bridge = JSON.parse(fs.readFileSync(path.join(fixture, 'state', 'bridge-config.json'), 'utf8'));
  const io = JSON.parse(fs.readFileSync(path.join(fixture, 'state', 'wechat-io-config.json'), 'utf8'));
  assert.equal(bridge.role, '# Test role');
  assert.equal(bridge.message_buffer.path, path.join(fixture, 'state', 'social-messages.json'));
  assert.equal(io.onebot_ws_url, `ws://127.0.0.1:${example.ports.onebot}/ws`);
  assert.equal(bridge.dsh_plugin.url, `http://127.0.0.1:${example.ports.dshPlugin}`);
  const token = fs.readFileSync(path.join(fixture, 'state', 'social-dsh-token.txt'), 'utf8');
  prepare(fixture);
  assert.equal(fs.readFileSync(path.join(fixture, 'state', 'social-dsh-token.txt'), 'utf8'), token);
  assert(!JSON.stringify(example).includes(token));
  const settingsFile = path.join(fixture, 'state', 'weflow', 'WeFlow-config.json');
  const settings = JSON.stringify({
    httpApiPort: 22222,
    httpApiHost: 'custom-host',
    decryptKey: 'fixture-encrypted-key',
  });
  fs.writeFileSync(settingsFile, settings);
  const configFile = path.join(fixture, 'config', 'wechatagent.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const bufferFile = path.join(fixture, 'state/social-messages.json');
  const unread = JSON.stringify({ chats: { 'wechat:private:456': [{ processed: false, text: 'fixture' }] } });
  fs.writeFileSync(bufferFile, unread);
  prepare(fixture);
  assert.equal(fs.readFileSync(bufferFile, 'utf8'), unread, 'preparing configuration must not consume pending input');
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), settings, 'database configuration must remain untouched');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(fixture, 'state', 'wechat-io-config.json'), 'utf8')).reader_token,
    io.reader_token,
  );
  assert.throws(() => validateConfig({ ...config, runtime: { ...config.runtime, sender: 'uia' } }), /sender/);
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
for (const file of [
  'components/qq-bridge/src/social-bridge.js',
  'packages/dsh-social-bridge-plugin/native-context.mjs',
  'components/qq-bridge/LICENSE',
  'components/weflow-cli/LICENSE',
])
  assert(fs.existsSync(path.join(projectRoot, file)), `Missing source/license: ${file}`);
console.log('Project config, portable paths, shared token preservation, and component completeness checks passed.');
