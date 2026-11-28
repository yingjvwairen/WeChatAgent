import { desktopManifest, seedDesktopPayloads } from './test-fixtures/desktop-deployment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import deployment from '../apps/console-desktop/deployment.cjs';
import {
  DSH_INSTALL_URL,
  DSH_SDK_VERSION,
  DSH_VERIFIED_DESKTOP_VERSION,
  dshInstallCard,
} from '../public/console/dsh-install.mjs';
import { taskFailureMessage } from './console-process.mjs';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-external-dsh-')),
    home = path.join(base, 'data');
  t.after(() => {
    assert(base.startsWith(os.tmpdir() + path.sep));
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const resourcesFor = (name, { bundled = false, version = 'fixture-1' } = {}) => {
    const resources = path.join(base, name),
      write = (file, value) => {
        const target = path.join(resources, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
      };
    write('project/config/wechatagent.example.json', {
      runtime: { sender: 'wechat-ui', python: 'python', dshDesktop: '' },
      persona: { default: 'Fixture', chats: {} },
      wechat: { whitelist: { private: [], groups: [] } },
    });
    write(
      'project/deployment.json',
      desktopManifest({ version, files: ['config/wechatagent.example.json'], dshSdkVersion: DSH_SDK_VERSION }),
    );
    for (const file of [
      'runtime/python/python.exe',
      'runtime/node.exe',
      'vendor/wechat/Weixin.exe',
      'vendor/hook/version.dll',
    ])
      write(file, 'fixture');
    write('vendor/hook/build.json', {});
    seedDesktopPayloads(write);
    return resources;
  };
  return { base, home, resourcesFor };
}

test('new external-only installations deploy successfully without a DSH payload or an automatically selected program', async t => {
  const f = fixture(t),
    resources = f.resourcesFor('external-only'),
    result = await deployment.bootstrapDeployment(resources, f.home),
    config = JSON.parse(fs.readFileSync(path.join(result.root, 'config/wechatagent.json'))),
    distribution = JSON.parse(fs.readFileSync(path.join(result.root, 'config/distribution.json')));
  assert.equal(config.runtime.dshDesktop, '');
  assert.equal(distribution.dshBundled, false);
  assert.equal(distribution.dsh, '');
  assert.equal(distribution.externalDshHome, process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  assert(fs.existsSync(result.node));
  assert(!fs.existsSync(path.join(f.home, 'runtimes/fixture-1/dsh')));
  assert(!fs.existsSync(path.join(f.home, 'dsh')));
  await deployment.bootstrapDeployment(resources, f.home);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.root, 'config/wechatagent.json'))).runtime.dshDesktop, '');
});

test('external-only upgrades retain the independently configured program instead of replacing it with a managed executable', async t => {
  const f = fixture(t),
    first = await deployment.bootstrapDeployment(f.resourcesFor('first'), f.home),
    file = path.join(first.root, 'config/wechatagent.json'),
    config = JSON.parse(fs.readFileSync(file));
  config.runtime.dshDesktop = path.join(f.base, 'independent', 'Harness.exe');
  fs.writeFileSync(file, JSON.stringify(config));
  await deployment.bootstrapDeployment(f.resourcesFor('second', { version: 'fixture-2' }), f.home);
  assert.equal(JSON.parse(fs.readFileSync(file)).runtime.dshDesktop, config.runtime.dshDesktop);
  assert(!fs.existsSync(path.join(f.home, 'runtimes/fixture-2/dsh')));
});

test('setup provides one official installation link, program selection and the existing plugin and launch controls', () => {
  const fields = [];
  const html = dshInstallCard({
    header: (title, help) => '<h2>' + title + '</h2><p>' + help + '</p>',
    field: (label, key, options) => {
      fields.push({ label, key, options });
      return '<input id="fixture-dsh-program">';
    },
    pluginPathField: () => '<button id="copy-plugin-path">复制插件路径</button>',
  });
  assert.equal(DSH_INSTALL_URL, 'https://www.deepseek.com/harness/');
  assert.equal((html.match(/href=/g) ?? []).length, 1);
  assert(html.includes('href="' + DSH_INSTALL_URL + '"'));
  assert(html.includes('target="_blank"'));
  assert(html.includes('data-action="dsh-open"'));
  assert(html.includes('copy-plugin-path'));
  assert.equal(fields[0].key, 'runtime.dshDesktop');
  assert.equal(fields[0].options.browse, 'exe');
  assert(html.includes('已验证的桌面版本为 ' + DSH_VERIFIED_DESKTOP_VERSION));
  assert(html.includes('随包 SDK 为 ' + DSH_SDK_VERSION));
});

test('missing programs and unavailable plugins report actionable setup instructions', () => {
  assert(taskFailureMessage('DSH_NOT_CONFIGURED: fixture', 1).includes('下载安装 DSH'));
  assert(taskFailureMessage('DSH_PLUGIN_NOT_READY: fixture', 1).includes('启用本机插件'));
});
