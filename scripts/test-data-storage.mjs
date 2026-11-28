import { desktopManifest, seedDesktopPayloads } from './test-fixtures/desktop-deployment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import storage from '../apps/console-desktop/storage-location.cjs';
import deployment from '../apps/console-desktop/deployment.cjs';
const {
  resolveStorageLocation,
  migrationPlan,
  retainDsh,
  deploymentStorageOptions,
  prepareDataHome,
  rebindExternalDsh,
} = storage;

test('moving data rebases model profiles and owned assets while preserving external models', async t => {
  const f = fixture(t);
  const owned = path.join(f.sourceRoot, 'state/models');
  const external = path.join(f.base, 'external-models/voice.pth');
  const profilesFile = path.join(f.sourceRoot, 'state/local-speech/tts.profiles.json');
  f.cfg.runtime.localSpeech = { tts: { modelDirectory: owned, profiles: profilesFile } };
  f.write(path.join(f.sourceRoot, 'config/wechatagent.json'), f.cfg);
  f.write(profilesFile, {
    voice: {
      gptWeights: path.join(owned, 'voice.ckpt'),
      sovitsWeights: external,
      refAudio: path.join(owned, 'reference.wav'),
      promptText: owned,
    },
  });
  f.write(path.join(f.sourceRoot, 'state/local-speech/asr.profiles.json'), {
    chinese: { modelDirectory: path.join(owned, 'whisper') },
  });
  await prepareDataHome(migrationPlan(f.location, { legacyDshHome: f.dsh }), { checkIdle: async () => {} });
  const destination = path.join(f.home, 'workspace');
  const read = relative => JSON.parse(fs.readFileSync(path.join(destination, relative)));
  const tts = read('config/wechatagent.json').runtime.localSpeech.tts;
  assert.equal(tts.modelDirectory, path.join(destination, 'state/models'));
  assert.equal(tts.profiles, path.join(destination, 'state/local-speech/tts.profiles.json'));
  const profile = read('state/local-speech/tts.profiles.json').voice;
  assert.equal(profile.gptWeights, path.join(destination, 'state/models/voice.ckpt'));
  assert.equal(profile.refAudio, path.join(destination, 'state/models/reference.wav'));
  assert.equal(profile.sovitsWeights, external);
  assert.equal(profile.promptText, owned);
  assert.equal(
    read('state/local-speech/asr.profiles.json').chinese.modelDirectory,
    path.join(destination, 'state/models/whisper'),
  );
  assert.equal(JSON.parse(fs.readFileSync(profilesFile)).voice.gptWeights, path.join(owned, 'voice.ckpt'));
});
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-data-layout-')),
    appDir = path.join(base, 'selected/app'),
    home = path.join(base, 'selected/data'),
    old = path.join(base, 'old AppData'),
    dsh = path.join(base, 'old .dsh');
  const write = (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
  };
  const cfg = {
    runtime: {
      sender: 'wechat-ui',
      python: path.join(old, 'runtimes/old/python/python.exe'),
      dshDesktop: 'E:/independent/DSH.exe',
    },
    persona: { default: 'Owner', chats: {} },
    wechat: { whitelist: { private: ['123'], groups: [] } },
  };
  write(path.join(old, 'workspace/config/wechatagent.json'), cfg);
  write(path.join(old, 'workspace/config/distribution.json'), {
    python: cfg.runtime.python,
    dsh: path.join(old, 'runtimes/old/dsh/Harness.exe'),
  });
  write(path.join(old, 'workspace/roles/Owner.md'), 'Personal role');
  write(path.join(old, 'workspace/state/weflow/WeFlow-config.json'), {
    dbPath: 'E:/original-wechat-db',
    decryptKey: 'userdpapi:protected',
  });
  write(path.join(old, 'workspace/state/social-messages.json'), {
    chats: {},
    pendingReplies: { test: { text: 'already decided' } },
    note: path.join(old, 'workspace/this is literal chat text'),
  });
  write(path.join(old, 'workspace/state/stickers/collected/test/index.json'), {
    path: path.join(old, 'workspace/state/stickers/collected/test/image.gif'),
  });
  write(path.join(old, 'workspace/state/stickers/collected/test/image.gif'), Buffer.from('GIF89a'));
  write(path.join(old, 'workspace/state/runtime.json'), { pid: 99999 });
  write(path.join(old, 'workspace/state/hook/wechat-4.1.10.27/Weixin.exe'), 'old-client');
  write(path.join(old, 'runtimes/old/node.exe'), 'old-runtime');
  fs.mkdirSync(appDir, { recursive: true });
  t.after(() => {
    assert(base.startsWith(os.tmpdir() + path.sep));
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return {
    base,
    appDir,
    home,
    old,
    dsh,
    cfg,
    write,
    location: { appDir, dataHome: home, migrationSource: old },
    sourceRoot: path.join(old, 'workspace'),
  };
}
test('installer location supports Unicode INI, explicit fresh installs, and separate app/data directories', t => {
  const f = fixture(t);
  f.write(
    path.join(f.appDir, 'storage.ini'),
    Buffer.from('\uFEFF[Storage]\r\ndataHome=' + f.home + '\r\nmigrationSource=\r\n', 'utf16le'),
  );
  const result = resolveStorageLocation({ appDir: f.appDir, legacyHome: f.old });
  assert.equal(result.dataHome, f.home);
  assert.equal(result.migrationSource, '');
  assert.throws(() => storage.validateLocation(f.appDir, path.join(f.appDir, 'data')), /分开/);
  assert.throws(() => storage.validateLocation(f.appDir, path.dirname(f.appDir)), /分开/);
});
test('relative database paths remain anchored to the original database and test overrides never import real data', async t => {
  const f = fixture(t);
  f.write(path.join(f.sourceRoot, 'state/weflow/WeFlow-config.json'), {
    dbPath: 'my-wechat-db',
    decryptKey: 'userdpapi:protected',
  });
  assert.equal(resolveStorageLocation({ appDir: f.appDir, legacyHome: f.old, override: f.home }).migrationSource, '');
  await prepareDataHome(migrationPlan(f.location, { legacyDshHome: f.dsh }), { checkIdle: async () => {} });
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.home, 'workspace/state/weflow/WeFlow-config.json'))).dbPath,
    path.join(f.sourceRoot, 'my-wechat-db'),
  );
});
test('migration preserves data and delivery receipts, rebases owned media paths and keeps the source unchanged', async t => {
  const f = fixture(t),
    sourceBefore = fs.readFileSync(path.join(f.sourceRoot, 'state/social-messages.json'));
  const plan = migrationPlan(f.location, { legacyDshHome: f.dsh });
  let checks = 0;
  const result = await prepareDataHome(plan, { checkIdle: async () => checks++ });
  assert(result.migrated);
  assert.equal(checks, 2);
  assert.deepEqual(fs.readFileSync(path.join(f.sourceRoot, 'state/social-messages.json')), sourceBefore);
  const root = path.join(f.home, 'workspace');
  const msg = JSON.parse(fs.readFileSync(path.join(root, 'state/social-messages.json')));
  assert.equal(msg.pendingReplies.test.text, 'already decided');
  assert.equal(msg.note, path.join(f.sourceRoot, 'this is literal chat text'));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, 'state/weflow/WeFlow-config.json'))).dbPath,
    'E:/original-wechat-db',
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, 'state/stickers/collected/test/index.json'))).path,
    path.join(root, 'state/stickers/collected/test/image.gif'),
  );
  assert(!fs.existsSync(path.join(root, 'state/runtime.json')));
  assert(!fs.existsSync(path.join(root, 'state/hook/wechat-4.1.10.27/Weixin.exe')));
  assert(!fs.existsSync(path.join(f.home, 'runtimes')));
  assert.equal(migrationPlan(f.location).needed, false);
  assert(fs.existsSync(path.join(f.old, 'runtimes/old/node.exe')));
});
test('busy source, changed files, verification failure and occupied targets do not switch or overwrite data', async t => {
  for (const mode of ['busy', 'changed', 'verify', 'occupied']) {
    const f = fixture(t);
    if (mode === 'occupied') {
      f.write(path.join(f.home, 'workspace/config/wechatagent.json'), 'existing');
      assert.throws(() => migrationPlan(f.location), /不能合并/);
      continue;
    }
    const plan = migrationPlan(f.location, { legacyDshHome: f.dsh });
    let checks = 0;
    await assert.rejects(
      prepareDataHome(plan, {
        checkIdle: async () => {
          checks++;
          if (mode === 'busy') throw Error('busy');
          if (mode === 'changed' && checks === 2) f.write(path.join(f.sourceRoot, 'roles/Owner.md'), 'Changed');
        },
        verify: async () => {
          if (mode === 'verify') throw Error('verification refused');
        },
      }),
    );
    assert(!fs.existsSync(path.join(f.home, '.wechatagent-data.json')));
    assert(!fs.existsSync(path.join(f.home, 'workspace')));
    assert(fs.existsSync(path.join(f.sourceRoot, 'config/wechatagent.json')));
  }
});

test('an explicitly selected source can be retried after its configuration becomes available', async t => {
  const f = fixture(t);
  const source = path.join(f.sourceRoot, 'config/wechatagent.json');
  const unavailable = source + '.fixture-offline';
  fs.renameSync(source, unavailable);
  assert.throws(() => migrationPlan(f.location), /旧数据.*配置/);
  assert.equal(fs.existsSync(path.join(f.home, '.wechatagent-data.json')), false);

  fs.renameSync(unavailable, source);
  const result = await prepareDataHome(migrationPlan(f.location), { checkIdle: async () => {} });
  assert.equal(result.migrated, true);
  assert.equal(result.report.source, f.old);
});

test('desktop preferences copied by an aborted migration are rolled back before retry', async t => {
  const f = fixture(t);
  const marker = path.join(f.home, '.wechatagent-data.json');
  const oldBackground = path.join(f.old, 'desktop/background.png');
  const copiedBackground = path.join(f.home, 'desktop/background.png');
  const existingWindow = path.join(f.home, 'desktop/window.json');
  const editedBackground = path.join(f.home, 'desktop/background.jpg');
  f.write(oldBackground, 'first source background');
  f.write(path.join(f.old, 'desktop/background.jpg'), 'previous photo');
  f.write(path.join(f.old, 'desktop/window.json'), { x: 20 });
  f.write(existingWindow, { x: 70 });
  const original = fs.renameSync;
  let refuseCommit = true;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === marker && refuseCommit) {
      fs.writeFileSync(editedBackground, 'a replacement desktop background');
      throw Error('fixture migration commit unavailable');
    }
    return original(from, to);
  });
  await assert.rejects(
    prepareDataHome(migrationPlan(f.location), { checkIdle: async () => {} }),
    /fixture migration commit unavailable/,
  );
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(path.join(f.home, 'workspace')), false);
  assert.equal(fs.existsSync(copiedBackground), false);
  assert.ok(!fs.readdirSync(f.home).some(name => name.startsWith('.wechatagent-data.json.')));
  assert.deepEqual(JSON.parse(fs.readFileSync(existingWindow)), { x: 70 });
  assert.equal(fs.readFileSync(editedBackground, 'utf8'), 'a replacement desktop background');
  assert.equal(fs.readFileSync(oldBackground, 'utf8'), 'first source background');

  f.write(oldBackground, 'updated source background');
  refuseCommit = false;
  const result = await prepareDataHome(migrationPlan(f.location), { checkIdle: async () => {} });
  assert.equal(result.migrated, true);
  assert.equal(fs.readFileSync(copiedBackground, 'utf8'), 'updated source background');
  assert.deepEqual(JSON.parse(fs.readFileSync(existingWindow)), { x: 70 });
  assert.equal(fs.readFileSync(editedBackground, 'utf8'), 'a replacement desktop background');
});

test('managed DSH copies opaque history and attachments while independent DSH only rebinds project paths with a backup', async t => {
  for (const managed of [true, false]) {
    const f = fixture(t);
    if (managed) {
      f.cfg.runtime.dshDesktop = path.join(f.old, 'runtimes/old/dsh/Harness.exe');
      f.write(path.join(f.sourceRoot, 'config/wechatagent.json'), f.cfg);
    }
    const journal = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 1, 2, 3]);
    f.write(path.join(f.dsh, 'sessions/old-project/social-test/session.v4.jsonl.zstd'), journal);
    f.write(path.join(f.dsh, 'attachments/file.png'), 'image');
    const relativeProfile = 'profiles/desktop/cordis.patch.yml';
    const neighboringRoot = managed ? f.old : f.sourceRoot;
    const sibling = path.join(neighboringRoot + '-shared', 'plugin.mjs');
    const siblingWithSpace = path.join(neighboringRoot + ' shared', 'plugin.mjs');
    const profile = root => {
      const plugin = path.join(root, 'packages/dsh-social-bridge-plugin/index.js');
      return [
        `name: ${plugin}`,
        `quoted: ${JSON.stringify(plugin)}`,
        `portable: ${plugin.replaceAll('\\', '/')}`,
        `url: ${pathToFileURL(plugin).href}`,
        `root: ${root} # keep this comment`,
        `roots: [${JSON.stringify(root)}, ${JSON.stringify(sibling)}]`,
        `sibling: ${sibling}`,
        `siblingWithSpace: ${siblingWithSpace}`,
        `siblingUrl: ${pathToFileURL(sibling).href}`,
        '',
      ].join('\r\n');
    };
    const original = profile(f.sourceRoot);
    const newRoot = path.join(f.home, 'workspace');
    f.write(path.join(f.dsh, relativeProfile), original);
    const plan = migrationPlan(f.location, { legacyDshHome: f.dsh });
    const result = await prepareDataHome(plan, { checkIdle: async () => {} });
    assert.equal(result.report.dshCopied, managed);
    if (managed) {
      assert.deepEqual(
        fs.readFileSync(path.join(f.home, 'dsh/sessions/old-project/social-test/session.v4.jsonl.zstd')),
        journal,
      );
      assert(fs.existsSync(path.join(f.home, 'dsh/attachments/file.png')));
      assert.equal(fs.readFileSync(path.join(f.home, 'dsh', relativeProfile), 'utf8'), profile(newRoot));
      assert.equal(fs.readFileSync(path.join(f.dsh, relativeProfile), 'utf8'), original);
    } else {
      const backup = path.join(f.home, 'backups/external-dsh/desktop/cordis.patch.yml');
      for (let attempt = 0; attempt < 2; attempt++) {
        await rebindExternalDsh(result.report, newRoot, f.home);
        assert.equal(fs.readFileSync(path.join(f.dsh, relativeProfile), 'utf8'), profile(newRoot));
        assert.equal(fs.readFileSync(backup, 'utf8'), original);
      }
      assert(!fs.existsSync(path.join(f.home, 'dsh')));
    }
  }
});

test('migration rebinds the DSH home-wide patch even without a profiles directory', async t => {
  for (const managed of [false, true]) {
    await t.test(managed ? 'copied DSH' : 'independent DSH', async t => {
      const f = fixture(t);
      if (managed) {
        f.cfg.runtime.dshDesktop = path.join(f.old, 'runtimes/old/dsh/Harness.exe');
        f.write(path.join(f.sourceRoot, 'config/wechatagent.json'), f.cfg);
      }
      const name = 'cordis.patch.yml';
      const original = path.join(f.dsh, name);
      const patch = root =>
        '- id: wechatagent\n  name: ' +
        pathToFileURL(path.join(root, 'packages/dsh-social-bridge-plugin/index.js')).href +
        '\n';
      const newRoot = path.join(f.home, 'workspace');
      f.write(original, patch(f.sourceRoot));
      f.write(path.join(f.dsh, 'other.yml'), patch(f.sourceRoot));
      const { report } = await prepareDataHome(migrationPlan(f.location, { legacyDshHome: f.dsh }), {
        checkIdle: async () => {},
      });
      assert.equal(report.dshCopied, managed);
      await rebindExternalDsh(report, newRoot, f.home);
      const dshHome = managed ? path.join(f.home, 'dsh') : f.dsh;
      assert.equal(fs.readFileSync(path.join(dshHome, name), 'utf8'), patch(newRoot));
      assert.equal(fs.readFileSync(path.join(dshHome, 'other.yml'), 'utf8'), patch(f.sourceRoot));
      const backup = managed ? original : path.join(f.home, 'backups/external-dsh', name);
      assert.equal(fs.readFileSync(backup, 'utf8'), patch(f.sourceRoot));
    });
  }
});

test('DSH migration rebases YAML paths without breaking quoted or flow scalars', async t => {
  const f = fixture(t);
  const source = f.sourceRoot;
  const home = path.join(f.base, "Ying's new #data [offline]");
  const target = path.join(home, 'workspace');
  const profile = path.join(f.dsh, 'profiles/desktop/cordis.patch.yml');
  const malformed = path.join(f.dsh, 'profiles/desktop/cordis.yml');
  const sibling = path.join(source + ', shared', 'plugin.mjs');
  const note = 'Keep an offline backup of ' + source;
  const sourceUrl = pathToFileURL(process.platform === 'win32' ? source.toLowerCase() : source).href;
  const options = '?profile=desktop#patch';
  const original = [
    '# desktop config',
    "quoted: &workspace '" + source.replaceAll("'", "''") + "'  # keep the comment",
    'flow: [' + source + ', *workspace]',
    'url: ' + sourceUrl + options,
    'base: ' + sourceUrl + '/' + options,
    'sibling: ' + sibling,
    'note: ' + note,
    'block: |- # keep the block comment',
    '  ' + source,
    '',
  ].join('\r\n');
  const malformedText = 'working: ' + source + '\nunfinished: [\n';
  f.write(profile, original);
  f.write(malformed, malformedText);
  const { report } = await prepareDataHome(migrationPlan({ ...f.location, dataHome: home }, { legacyDshHome: f.dsh }), {
    checkIdle: async () => {},
  });
  await rebindExternalDsh(report, target, home);
  const result = fs.readFileSync(profile, 'utf8');
  assert.deepEqual(parseYaml(result), {
    quoted: target,
    flow: [target, target],
    url: pathToFileURL(target).href + options,
    base: pathToFileURL(target).href + '/' + options,
    sibling,
    note,
    block: target,
  });
  assert.match(result, /  # keep the comment\r\n/);
  assert.match(result, /block: \|- # keep the block comment\r\n/);
  assert.equal(fs.readFileSync(malformed, 'utf8'), malformedText);
  assert.equal(fs.readFileSync(path.join(home, 'backups/external-dsh/desktop/cordis.patch.yml'), 'utf8'), original);
});

test('an interrupted DSH backup is not reused as a complete backup on retry', async t => {
  const f = fixture(t);
  const profile = path.join(f.dsh, 'profiles/desktop/cordis.patch.yml');
  const backup = path.join(f.home, 'backups/external-dsh/desktop/cordis.patch.yml');
  const newRoot = path.join(f.home, 'workspace');
  const original = root => 'projectRoot: ' + root + '\n';
  f.write(profile, original(f.sourceRoot));
  const { report } = await prepareDataHome(migrationPlan(f.location, { legacyDshHome: f.dsh }), {
    checkIdle: async () => {},
  });
  const writeFile = fs.promises.writeFile;
  let fail = true;
  t.mock.method(fs.promises, 'writeFile', async (file, bytes, options) => {
    if (fail && (file === backup || file.startsWith(backup + '.'))) {
      fail = false;
      await writeFile(file, 'partial backup', options);
      throw Error('test: short backup write');
    }
    return writeFile(file, bytes, options);
  });

  await assert.rejects(rebindExternalDsh(report, newRoot, f.home), /short backup write/);
  assert.equal(fs.readFileSync(profile, 'utf8'), original(f.sourceRoot));
  assert.deepEqual(fs.readdirSync(path.dirname(backup)), []);

  await rebindExternalDsh(report, newRoot, f.home);
  assert.equal(fs.readFileSync(profile, 'utf8'), original(newRoot));
  assert.equal(fs.readFileSync(backup, 'utf8'), original(f.sourceRoot));
});

test('an external DSH profile write failure preserves both originals and allows a retry', async t => {
  const f = fixture(t);
  const profileDir = path.join(f.dsh, 'profiles/desktop');
  const config = path.join(profileDir, 'cordis.yml');
  const patch = path.join(profileDir, 'cordis.patch.yml');
  const original = root => 'projectRoot: ' + root + '\n';
  f.write(config, original(f.sourceRoot));
  f.write(patch, original(f.sourceRoot));
  const plan = migrationPlan(f.location, { legacyDshHome: f.dsh });
  const { report } = await prepareDataHome(plan, { checkIdle: async () => {} });
  const newRoot = path.join(f.home, 'workspace');
  const writeFile = fs.promises.writeFile;
  let fail = true;
  t.mock.method(fs.promises, 'writeFile', async (file, bytes, options) => {
    if (fail && (file === patch || (typeof file === 'string' && file.startsWith(patch + '.')))) {
      fail = false;
      await writeFile(file, 'partial write', options);
      throw Error('test: short profile write');
    }
    return writeFile(file, bytes, options);
  });

  await assert.rejects(rebindExternalDsh(report, newRoot, f.home), /short profile write/);
  for (const file of [config, patch]) {
    assert.equal(fs.readFileSync(file, 'utf8'), original(f.sourceRoot));
    assert.equal(
      fs.readFileSync(path.join(f.home, 'backups/external-dsh/desktop', path.basename(file)), 'utf8'),
      original(f.sourceRoot),
    );
  }
  assert.deepEqual(fs.readdirSync(profileDir).sort(), ['cordis.patch.yml', 'cordis.yml']);

  await rebindExternalDsh(report, newRoot, f.home);
  for (const file of [config, patch]) assert.equal(fs.readFileSync(file, 'utf8'), original(newRoot));
});

test('an external DSH profile rollback preserves edits made after the profile was replaced', async t => {
  const f = fixture(t);
  const profileDir = path.join(f.dsh, 'profiles/desktop');
  const config = path.join(profileDir, 'cordis.yml');
  const patch = path.join(profileDir, 'cordis.patch.yml');
  const original = 'projectRoot: ' + f.sourceRoot + '\n';
  const newRoot = path.join(f.home, 'workspace');
  const edited = 'projectRoot: ' + newRoot + '\nkeepMyEdit: true\n';
  f.write(config, original);
  f.write(patch, original);
  const { report } = await prepareDataHome(migrationPlan(f.location, { legacyDshHome: f.dsh }), {
    checkIdle: async () => {},
  });
  const writeFile = fs.promises.writeFile;
  let fail = true;
  t.mock.method(fs.promises, 'writeFile', async (file, bytes, options) => {
    if (fail && (file === patch || (typeof file === 'string' && file.startsWith(patch + '.')))) {
      fail = false;
      await writeFile(config, edited);
      throw Error('test: profile write interrupted');
    }
    return writeFile(file, bytes, options);
  });

  await assert.rejects(rebindExternalDsh(report, newRoot, f.home), /部分 DSH 配置未回滚/);
  assert.equal(fs.readFileSync(config, 'utf8'), edited);
  assert.equal(fs.readFileSync(patch, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(profileDir).sort(), ['cordis.patch.yml', 'cordis.yml']);

  await rebindExternalDsh(report, newRoot, f.home);
  assert.equal(fs.readFileSync(config, 'utf8'), edited);
  assert.equal(fs.readFileSync(patch, 'utf8'), 'projectRoot: ' + newRoot + '\n');
});

test('retaining DSH leaves its history, external links, config and executable binding in place across migration and restart', async t => {
  for (const mode of ['managed', 'independent', 'nested-home', 'backup-home']) {
    const f = fixture(t),
      dsh =
        mode === 'nested-home'
          ? path.join(f.sourceRoot, 'state/old-dsh')
          : mode === 'backup-home'
            ? path.join(f.old, 'backups/dsh-home')
            : f.dsh;
    const exe =
      mode === 'independent'
        ? path.join(f.base, 'independent/Harness.exe')
        : path.join(f.old, 'runtimes/old/dsh/Harness.exe');
    f.cfg.runtime.dshDesktop = exe;
    f.write(path.join(f.sourceRoot, 'config/wechatagent.json'), f.cfg);
    f.write(exe, 'old DSH program');
    f.write(path.join(f.sourceRoot, 'config/distribution.json'), {
      python: f.cfg.runtime.python,
      dsh: path.join(f.old, 'runtimes/old/dsh/Harness.exe'),
      dshHome: dsh,
      externalDshHome: dsh,
    });
    const history = path.join(dsh, 'sessions/old-project/social-test/session.v4.jsonl.zstd'),
      profile = path.join(dsh, 'profiles/desktop/cordis.patch.yml'),
      homePatch = path.join(dsh, 'cordis.patch.yml');
    const journal = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 1, 2, 3]);
    f.write(history, journal);
    const originalPatch = 'plugin: ' + path.join(f.sourceRoot, 'packages/dsh-social-bridge-plugin');
    f.write(profile, originalPatch);
    f.write(homePatch, originalPatch);
    f.write(path.join(dsh, 'attachments/image.png'), 'image');
    const outside = path.join(f.base, 'external plugin');
    f.write(path.join(outside, 'keep.txt'), 'external data');
    const link = path.join(dsh, 'external-plugin');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    f.write(path.join(f.sourceRoot, 'state/dsh-reference.json'), { path: path.join(dsh, 'attachments/image.png') });
    f.write(path.join(f.sourceRoot, 'state/weflow/WeFlow-config.json'), {
      dbPath: 'my-wechat-db',
      decryptKey: 'userdpapi:protected',
    });
    const originalConfig = fs.readFileSync(path.join(f.sourceRoot, 'config/wechatagent.json')),
      originalLink = fs.readlinkSync(link);
    const plan = retainDsh(migrationPlan(f.location, { legacyDshHome: dsh })),
      result = await prepareDataHome(plan, { checkIdle: async () => {} });
    assert(result.migrated);
    assert.equal(result.report.dshRetained, true);
    assert.equal(result.report.dshCopied, false);
    assert.equal(result.report.oldDshHome, dsh);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(f.home, 'workspace/config/wechatagent.json'))).runtime.dshDesktop,
      exe,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(f.home, 'workspace/state/dsh-reference.json'))).path,
      path.join(dsh, 'attachments/image.png'),
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(f.home, 'workspace/state/weflow/WeFlow-config.json'))).dbPath,
      path.join(f.sourceRoot, 'my-wechat-db'),
    );
    assert(!fs.existsSync(path.join(f.home, 'dsh')));
    assert(!fs.existsSync(path.join(f.home, 'workspace/state/old-dsh')));
    assert(!fs.existsSync(path.join(f.home, 'backups/dsh-home')));
    const resources = path.join(f.base, 'new app/resources');
    for (const [relative, value] of Object.entries({
      'project/deployment.json': desktopManifest({ version: 'new', files: [] }),
      'runtime/python/python.exe': 'python',
      'runtime/node.exe': 'node',
      'vendor/wechat/Weixin.exe': 'wechat',
      'vendor/hook/version.dll': 'hook',
      'vendor/hook/build.json': {},
    }))
      f.write(path.join(resources, relative), value);
    for (let launch = 0; launch < 2; launch++) {
      const nextPlan = migrationPlan(f.location);
      assert.equal(nextPlan.needed, false);
      assert.equal(nextPlan.report.dshRetained, true);
      seedDesktopPayloads((relative, value) => f.write(path.join(resources, relative), value));
      await deployment.bootstrapDeployment(
        resources,
        f.home,
        () => {},
        deploymentStorageOptions(nextPlan.report, f.home),
      );
      await rebindExternalDsh(nextPlan.report, path.join(f.home, 'workspace'), f.home);
      const cfg = JSON.parse(fs.readFileSync(path.join(f.home, 'workspace/config/wechatagent.json'))),
        dist = JSON.parse(fs.readFileSync(path.join(f.home, 'workspace/config/distribution.json')));
      assert.equal(cfg.runtime.dshDesktop, exe);
      assert.equal(dist.dshHome, dsh);
      assert.equal(dist.externalDshHome, dsh);
      assert(fs.existsSync(exe));
      assert(cfg.runtime.python.startsWith(path.join(f.home, 'runtimes')));
      assert.deepEqual(fs.readFileSync(history), journal);
      assert.equal(fs.readFileSync(profile, 'utf8'), originalPatch);
      assert.equal(fs.readFileSync(homePatch, 'utf8'), originalPatch);
      assert.equal(fs.readlinkSync(link), originalLink);
      assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'external data');
      assert(!fs.existsSync(path.join(f.home, 'backups/external-dsh')));
      assert(!fs.existsSync(path.join(f.home, 'dsh')));
    }
    assert.deepEqual(fs.readFileSync(path.join(f.sourceRoot, 'config/wechatagent.json')), originalConfig);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(f.home, 'workspace/state/social-messages.json'))).pendingReplies.test.text,
      'already decided',
    );
  }
});

test('a DSH external-link failure can retry with retention without bypassing links in WeChatAgent data', async t => {
  const f = fixture(t);
  f.cfg.runtime.dshDesktop = path.join(f.old, 'runtimes/old/dsh/Harness.exe');
  f.write(path.join(f.sourceRoot, 'config/wechatagent.json'), f.cfg);
  const outside = path.join(f.base, 'external attachments');
  f.write(path.join(outside, 'keep.txt'), 'keep');
  fs.mkdirSync(f.dsh, { recursive: true });
  const link = path.join(f.dsh, 'external');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const plan = migrationPlan(f.location, { legacyDshHome: f.dsh });
  await assert.rejects(
    prepareDataHome(plan, { checkIdle: async () => {} }),
    error =>
      error.code === 'DSH_EXTERNAL_LINK' &&
      error.message.includes(link) &&
      error.message.includes(fs.realpathSync.native(outside)),
  );
  assert(!fs.existsSync(path.join(f.home, '.wechatagent-data.json')));
  assert(!fs.existsSync(path.join(f.home, 'workspace')));
  assert((await prepareDataHome(retainDsh(plan), { checkIdle: async () => {} })).migrated);
  const other = fixture(t),
    active = path.join(other.sourceRoot, 'state/external');
  fs.symlinkSync(outside, active, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    prepareDataHome(retainDsh(migrationPlan(other.location, { legacyDshHome: other.dsh })), {
      checkIdle: async () => {},
    }),
    error => error.message.includes(active) && error.code !== 'DSH_EXTERNAL_LINK',
  );
  assert(!fs.existsSync(path.join(other.home, '.wechatagent-data.json')));
  assert(fs.lstatSync(active).isSymbolicLink());
});

test('external-only distributions keep the actual bound DSH home without classifying it as bundled again', async t => {
  const f = fixture(t),
    exe = path.join(f.old, 'runtimes/old/dsh/Harness.exe');
  f.cfg.runtime.dshDesktop = exe;
  f.write(path.join(f.sourceRoot, 'config/wechatagent.json'), f.cfg);
  f.write(path.join(f.dsh, 'sessions/keep.txt'), 'history');
  f.write(path.join(f.sourceRoot, 'config/distribution.json'), {
    dshBundled: false,
    dsh: exe,
    dshHome: f.dsh,
    externalDshHome: path.join(f.base, 'different default .dsh'),
  });
  const plan = migrationPlan(f.location);
  assert.equal(plan.managedDsh, false);
  assert.equal(plan.migrateDsh, false);
  assert.equal(plan.oldDshHome, f.dsh);
  assert.deepEqual(deploymentStorageOptions(undefined, f.home), {});
  assert.equal(deploymentStorageOptions({ source: f.old, dshCopied: true }, f.home).dshHome, path.join(f.home, 'dsh'));
  assert.equal(
    deploymentStorageOptions({ source: f.old, managedDsh: false, dshCopied: false, oldDshHome: f.dsh }, f.home).dshHome,
    undefined,
  );
  const result = await prepareDataHome(plan, { checkIdle: async () => {} });
  assert.equal(result.report.dshCopied, false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.home, 'workspace/config/wechatagent.json'))).runtime.dshDesktop,
    exe,
  );
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, 'workspace/config/distribution.json'))).dsh, exe);
});

function backupLink(f, { missing = false, name = 'dsh-social-bridge-plugin.original-link', target } = {}) {
  const original = target || path.join(f.base, 'developer checkout/packages/dsh-social-bridge-plugin');
  if (!missing) f.write(path.join(original, 'must-not-be-copied.txt'), 'outside the old data source');
  const file = path.join(f.old, 'backups/before-0.3.6-repair-20261018/dsh', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.symlinkSync(original, file, process.platform === 'win32' ? 'junction' : 'dir');
  return { file, target: original, rawTarget: fs.readlinkSync(file) };
}

test('legacy plugin backup junctions migrate as reference metadata without copying or recreating the external directory', async t => {
  const f = fixture(t),
    link = backupLink(f);
  f.write(path.join(f.old, 'backups/owner-backup.json'), { keep: true });
  const before = fs.readFileSync(path.join(f.sourceRoot, 'config/wechatagent.json'));
  const result = await prepareDataHome(migrationPlan(f.location, { legacyDshHome: f.dsh }), {
    checkIdle: async () => {},
  });
  assert(result.migrated);
  assert.equal(result.report.archivedBackupLinks, 1);
  const record = JSON.parse(fs.readFileSync(path.join(f.home, result.report.backupLinkFile)));
  assert.equal(record.policy, 'reference-only');
  assert.equal(record.links[0].source, link.file);
  assert.equal(record.links[0].target, link.rawTarget);
  assert.equal(record.links[0].copiedTarget, false);
  assert(
    !fs.existsSync(
      path.join(f.home, 'backups/before-0.3.6-repair-20261018/dsh/dsh-social-bridge-plugin.original-link'),
    ),
  );
  assert.equal(fs.readlinkSync(link.file), link.rawTarget);
  assert(fs.existsSync(path.join(link.target, 'must-not-be-copied.txt')));
  assert.deepEqual(fs.readFileSync(path.join(f.sourceRoot, 'config/wechatagent.json')), before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, 'backups/owner-backup.json'))).keep, true);
});

test('a dangling legacy plugin backup reference is retained without reading its missing target', async t => {
  const f = fixture(t),
    link = backupLink(f, { missing: true });
  assert(!fs.existsSync(link.target));
  const result = await prepareDataHome(migrationPlan(f.location, { legacyDshHome: f.dsh }), {
    checkIdle: async () => {},
  });
  assert.equal(result.report.archivedBackupLinks, 1);
  const record = JSON.parse(fs.readFileSync(path.join(f.home, result.report.backupLinkFile)));
  assert.equal(record.links[0].target, link.rawTarget);
  assert.equal(fs.readlinkSync(link.file), link.rawTarget);
});

test('unrecognized backup junctions and links in active user data still stop with the exact path and preserve the source', async t => {
  for (const mode of ['unknown-name', 'wrong-target', 'active-data']) {
    const f = fixture(t);
    let file;
    if (mode === 'active-data') {
      const target = path.join(f.base, 'external owner files');
      f.write(path.join(target, 'keep.txt'), 'keep');
      file = path.join(f.sourceRoot, 'state/linked-media');
      fs.symlinkSync(target, file, process.platform === 'win32' ? 'junction' : 'dir');
    } else
      file = backupLink(
        f,
        mode === 'unknown-name'
          ? { name: 'unrecognized.original-link' }
          : { target: path.join(f.base, 'external owner files') },
      ).file;
    await assert.rejects(
      prepareDataHome(migrationPlan(f.location, { legacyDshHome: f.dsh }), { checkIdle: async () => {} }),
      error => error.message.includes(file) && error.message.includes('目录联接'),
    );
    assert(!fs.existsSync(path.join(f.home, 'workspace')));
    assert(!fs.existsSync(path.join(f.home, '.wechatagent-data.json')));
    assert(fs.lstatSync(file).isSymbolicLink());
    assert(fs.existsSync(path.join(f.sourceRoot, 'config/wechatagent.json')));
  }
});

test('changing a recognized backup link during copying cancels migration without committing the new data home', async t => {
  const f = fixture(t),
    link = backupLink(f),
    replacement = path.join(f.base, 'other checkout/packages/dsh-social-bridge-plugin');
  f.write(path.join(replacement, 'keep.txt'), 'keep');
  let checks = 0;
  await assert.rejects(
    prepareDataHome(migrationPlan(f.location, { legacyDshHome: f.dsh }), {
      checkIdle: async () => {
        if (++checks === 2) {
          fs.unlinkSync(link.file);
          fs.symlinkSync(replacement, link.file, process.platform === 'win32' ? 'junction' : 'dir');
        }
      },
    }),
    error => error.message.includes(link.file) && error.message.includes('发生变化'),
  );
  assert(!fs.existsSync(path.join(f.home, '.wechatagent-data.json')));
  assert(!fs.existsSync(path.join(f.home, 'workspace')));
  assert(fs.existsSync(path.join(f.sourceRoot, 'config/wechatagent.json')));
  assert.equal(path.resolve(fs.readlinkSync(link.file)), path.resolve(replacement));
});

test(
  'migration retries transient Windows sharing errors when publishing the verified workspace',
  {
    skip: process.platform !== 'win32',
  },
  async t => {
    const f = fixture(t);
    const plan = migrationPlan(f.location);
    const original = fs.promises.rename;
    const workspace = path.join(f.home, 'workspace');
    let blocked = false;
    t.mock.method(fs.promises, 'rename', async (from, to) => {
      if (to === workspace && !blocked) {
        blocked = true;
        throw Object.assign(Error('fixture sharing violation'), { code: 'EPERM' });
      }
      return original.call(fs.promises, from, to);
    });
    const result = await prepareDataHome(plan, { checkIdle: async () => {} });
    assert.equal(blocked, true);
    assert.equal(result.migrated, true);
    assert.equal(fs.existsSync(path.join(workspace, 'config/wechatagent.json')), true);
  },
);
