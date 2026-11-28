import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProcessRecovery, startupConflictPorts } from './process-recovery.mjs';
import { createConsole } from './console-server.mjs';
import { createWorkspaceLayout } from '../public/console/workspace-layout.js';
import { needsWeChatRestart, openProcessRecovery } from '../public/console/process-recovery.js';
import { dshConfigurationMatches } from './dsh-configuration.mjs';

const config = {
  ports: { weflow: 5031, onebot: 11229, adapter: 8766, dshPlugin: 11230 },
  input: { wechatExecutable: 'C:/fixture/Weixin.exe' },
  dsh: { provider: 'fixture', model: 'fixture-model' },
};
const item = {
  pid: 333,
  name: 'node.exe',
  path: 'E:/fixture/node.exe',
  start: '100',
  commandHash: 'fixture-command',
  ports: [5031],
  reason: '占用读取端口',
  canStop: true,
};
test('startup conflicts override stale healthy port caches only for configured ports', () => {
  assert.deepEqual(
    startupConflictPorts(
      'Adapter startup failed: ADAPTER_PORT_IN_USE stage=adapter-port-bind port=8766 system=EADDRINUSE\nSERVICE_PORT_OWNER_MISMATCH service=reader port=5031 owners=33\nSERVICE_PORT_IN_USE port=9999 owners=1',
      [5031, 8766],
    ),
    [8766, 5031],
  );
  assert.deepEqual(
    startupConflictPorts('READER_CONNECTION_RESET port=5031\nchat contains port=8766', [5031, 8766]),
    [],
  );
});
function fixture() {
  let items = [{ ...item }],
    time = 1000;
  const stopped = [];
  const recovery = createProcessRecovery({
    root: process.cwd(),
    now: () => time,
    probe: async () => ({ items }),
    stop: async request => {
      stopped.push(request);
      return { stopped: request.items.map(item => item.pid) };
    },
  });
  return {
    recovery,
    stopped,
    setItems: next => {
      items = next;
    },
    expire: () => {
      time += 120001;
    },
  };
}

test('inspection and first confirmation never stop a process; final confirmation is explicit and single-use', async () => {
  const f = fixture(),
    scan = await f.recovery.scan(config, 'revision');
  assert.equal(f.stopped.length, 0);
  assert.equal(scan.items[0].commandHash, undefined);
  const prepared = await f.recovery.prepare(scan.scanId, [scan.items[0].id], 'revision');
  assert.equal(f.stopped.length, 0);
  await assert.rejects(f.recovery.stop(prepared.confirmation, false, 'revision'), /确认/);
  assert.equal(f.stopped.length, 0);
  assert.deepEqual((await f.recovery.stop(prepared.confirmation, true, 'revision')).stopped, [333]);
  assert.equal(f.stopped.length, 1);
  await assert.rejects(f.recovery.stop(prepared.confirmation, true, 'revision'), /确认/);
  assert.equal(f.stopped.length, 1);
});
test('reused PIDs, changed executables, commands, port owners and permissions are rejected before termination', async () => {
  for (const update of [
    { start: '101' },
    { path: 'E:/other.exe' },
    { commandHash: 'different' },
    { ports: [8766] },
    { canStop: false },
  ]) {
    const f = fixture(),
      scan = await f.recovery.scan(config, 'r'),
      prepared = await f.recovery.prepare(scan.scanId, [scan.items[0].id], 'r');
    f.setItems([{ ...item, ...update }]);
    await assert.rejects(f.recovery.stop(prepared.confirmation, true, 'r'), /变化/);
    assert.equal(f.stopped.length, 0);
  }
});
test('blocked, arbitrary and duplicate selections, expired inspections and changed settings cannot authorize termination', async () => {
  const f = fixture();
  f.setItems([{ ...item, canStop: false }]);
  const scan = await f.recovery.scan(config, 'r');
  for (const ids of [[scan.items[0].id], ['333'], [], [scan.items[0].id, scan.items[0].id]])
    await assert.rejects(f.recovery.prepare(scan.scanId, ids, 'r'));
  f.setItems([item]);
  const next = await f.recovery.scan(config, 'r'),
    prepared = await f.recovery.prepare(next.scanId, [next.items[0].id], 'r');
  await assert.rejects(f.recovery.stop(prepared.confirmation, true, 'new-revision'), /配置/);
  f.expire();
  await assert.rejects(f.recovery.prepare(next.scanId, [next.items[0].id], 'r'));
  await assert.rejects(f.recovery.stop(prepared.confirmation, true, 'r'));
  assert.equal(f.stopped.length, 0);
});
test('stopping selected conflicts never adds unselected processes', async () => {
  const f = fixture();
  f.setItems([item, { ...item, pid: 444, start: '200', ports: [11230] }]);
  const scan = await f.recovery.scan(config, 'r');
  const prepared = await f.recovery.prepare(scan.scanId, [scan.items[1].id], 'r');
  await f.recovery.stop(prepared.confirmation, true, 'r');
  assert.deepEqual(
    f.stopped[0].items.map(item => item.pid),
    [444],
  );
});
test('DSH restart verification requires the actual project, model, plugin revision and selected account', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-dsh-revision-'));
  t.after(() => {
    assert(root.startsWith(os.tmpdir() + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'packages/dsh-social-bridge-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state/weflow'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'packages/dsh-social-bridge-plugin/cordis.patch.yml'),
    'name: file:///fixture/native-context.mjs?wechatagent=aaaaaaaaaaaaaaaa',
  );
  fs.writeFileSync(path.join(root, 'state/weflow/active-account.json'), JSON.stringify({ id: 'account-a' }));
  const health = {
    ok: true,
    project: 'WeChatAgent',
    projectRoot: root,
    provider: 'fixture',
    model: 'fixture-model',
    pluginRevision: 'aaaaaaaaaaaaaaaa',
    accountScope: 'account-a',
  };
  assert(dshConfigurationMatches(root, config, health));
  for (const change of [
    { ok: false },
    { projectRoot: root + '-other' },
    { provider: 'other' },
    { model: 'old-model' },
    { pluginRevision: 'bbbbbbbbbbbbbbbb' },
    { accountScope: 'account-b' },
  ])
    assert.equal(dshConfigurationMatches(root, config, { ...health, ...change }), false);
});

test('the rendered send check and the selected-client restart use the current console API', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-console-diagnostics-'));
  const settings = JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json', import.meta.url)));
  const selected = path.join(root, 'client', 'Weixin.exe');
  settings.input.wechatExecutable = selected;
  settings.ports = { weflow: 0, onebot: 0, adapter: 0, dshPlugin: 0 };
  const file = path.join(root, 'config/wechatagent.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings));

  const probes = [],
    stops = [],
    commands = [],
    discovery = [];
  const savedPath = path.join(root, 'previous-account');
  const readerFile = path.join(root, 'state/weflow/WeFlow-config.json');
  fs.mkdirSync(path.dirname(readerFile), { recursive: true });
  fs.writeFileSync(readerFile, JSON.stringify({ dbPath: savedPath, decryptKey: 'test-only-secret' }));
  const client = { ...item, pid: 444, name: 'Weixin.exe', path: selected, ports: [] };
  const app = createConsole({
    root,
    port: 0,
    runner: async spec => {
      commands.push(spec);
      return 0;
    },
    processProbe: async input => {
      probes.push(input);
      return { items: [item, client, { ...client, path: path.join(root, 'other', 'Weixin.exe'), canStop: false }] };
    },
    readerSetup: async ({ request }) => {
      discovery.push(request);
      return { ok: true, accounts: [] };
    },
    wechatClientInspector: async ({ executable }) => ({ path: executable, version: '4.2.0.53' }),
    processStop: async request => {
      stops.push(request);
      return { stopped: request.items.map(row => row.pid) };
    },
    fetchImpl: async () => {
      throw Error('fixture services are offline');
    },
  });
  const address = await app.start(),
    base = 'http://127.0.0.1:' + address.port;
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { token } = await fetch(base + '/api/info').then(r => r.json());
  async function request(route, body) {
    const response = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Console-Token': token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  }
  const ui = createWorkspaceLayout({
    state: { settingsSection: 'diagnostics', names: new Map() },
    api: async route => (await request(route)).data,
    getCards: () => ({}),
    escapeHtml: String,
    header: () => '',
    icon: () => '',
  });
  const html = await ui.settingsPage();
  const action = html.match(/data-action="([^"]+)">检查发送<\/button>/)?.[1];
  assert.equal(action, 'desktop-check');
  const checked = await request('/api/jobs', { action });
  assert(checked.status < 300);
  assert.equal(commands.length, 1);
  assert.equal(path.basename(commands[0].args.at(-2)), 'wechat-onebot.mjs');
  assert.equal(commands[0].args.at(-1), '--check');
  assert.match(html, /data-restart-wechat/);

  const { data: scan } = await request('/api/process-recovery?purpose=wechat-restart');
  assert.equal(scan.purpose, 'wechat-restart');
  assert.deepEqual(probes.at(-1).ports, []);
  assert.equal(probes.at(-1).matchingWeChatOnly, true);
  assert.equal(probes.at(-1).wechatExecutable, selected);
  assert.deepEqual(
    scan.items.map(row => row.path),
    [selected],
  );
  const { data: prepared } = await request('/api/process-recovery/prepare', {
    scanId: scan.scanId,
    ids: [scan.items[0].id],
  });
  assert.equal(stops.length, 0);
  assert.equal(
    (await request('/api/process-recovery/stop', { confirmation: prepared.confirmation, confirmed: false })).status,
    409,
  );
  assert.equal(
    (await request('/api/process-recovery/stop', { confirmation: prepared.confirmation, confirmed: true })).status,
    200,
  );
  assert.deepEqual(
    stops[0].items.map(row => row.path),
    [selected],
  );
  assert((await request('/api/jobs', { action: 'wechat-open', revision: scan.revision })).status < 300);
  const openArgs = commands.at(-1).args;
  assert.equal(path.basename(openArgs[openArgs.indexOf('-ScriptPath') + 1]), 'launch-wechat.ps1');
  assert.deepEqual(JSON.parse(Buffer.from(openArgs[openArgs.indexOf('-ArgumentsBase64') + 1], 'base64').toString()), [
    selected,
  ]);
  settings.input.wechatExecutable = path.join(root, 'other', 'Weixin.exe');
  fs.writeFileSync(file, JSON.stringify(settings));
  assert.equal((await request('/api/jobs', { action: 'wechat-open', revision: scan.revision })).status, 409);
  assert.equal(commands.length, 2);
  assert.equal((await request('/api/process-recovery?purpose=retired')).status, 400);
  settings.input.wechatExecutable = '';
  fs.writeFileSync(file, JSON.stringify(settings));
  const { data: found } = await request('/api/reader-accounts', { dbPath: '' });
  assert.equal(found.candidate.path, selected);
  assert.deepEqual(probes.at(-1).ports, []);
  assert.deepEqual(discovery.at(-1), {
    operation: 'discover',
    dbPath: '',
    wechatExecutable: selected,
    savedAccountPath: savedPath,
  });
  const { data: manual } = await request('/api/reader-accounts', { dbPath: savedPath });
  assert.equal(manual.candidate, undefined);
  assert.equal(discovery.at(-1).wechatExecutable, undefined);
  assert.equal(discovery.at(-1).dbPath, savedPath);
  assert.equal(stops.length, 1);
  assert.equal(commands.length, 2);
  assert.equal((await request('/api/process-recovery?purpose=wechat-restart')).status, 409);
  const { data: general } = await request('/api/process-recovery');
  assert.equal(general.purpose, 'ports');
  assert.equal(probes.at(-1).matchingWeChatOnly, false);
  assert.equal(needsWeChatRestart('Desktop sender check failed: DESKTOP_WINDOW_NOT_READY'), true);
  assert.equal(needsWeChatRestart('READER_SETUP_CLEANUP_UNCONFIRMED'), true);
  assert.equal(needsWeChatRestart('READER_NOT_LISTENING'), false);
});

test('the restart dialog opens an absent client using the inspected configuration revision', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete globalThis.document;
  });
  let open, reopened;
  const body = {
    innerHTML: '',
    querySelectorAll: () => [],
    querySelector(selector) {
      if (selector === '[data-recovery-open]')
        return {
          addEventListener: (_event, handler) => {
            open = handler;
          },
        };
      if (selector === '[data-recovery-rescan]') return {};
      return null;
    },
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { querySelector: s => (s === '#modal-content' ? body : {}) },
  });
  const calls = [];
  await openProcessRecovery({
    restartWeChat: true,
    modal() {},
    api: async route => {
      calls.push(route);
      return { purpose: 'wechat-restart', revision: 'known-settings', items: [] };
    },
    onRecovered: revision => {
      reopened = revision;
    },
  });
  assert.deepEqual(calls, ['/api/process-recovery?purpose=wechat-restart']);
  assert.equal(reopened, undefined);
  await open();
  assert.equal(reopened, 'known-settings');
  assert.equal(calls.length, 1);
});

test(
  'the launcher checks the selected executable again before opening a changed configuration',
  { skip: process.platform !== 'win32' },
  t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-restart-binding-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, 'config'));
    const script = path.join(root, 'scripts', 'launch-wechat.ps1');
    fs.copyFileSync(new URL('./launch-wechat.ps1', import.meta.url), script);
    const first = path.join(root, 'first', 'Weixin.exe'),
      second = path.join(root, 'second', 'Weixin.exe');
    fs.writeFileSync(
      path.join(root, 'config', 'wechatagent.json'),
      JSON.stringify({ runtime: { sender: 'wechat-ui' }, input: { wechatExecutable: second } }),
    );
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, first],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DESKTOP_CLIENT_CHANGED/);
  },
);
