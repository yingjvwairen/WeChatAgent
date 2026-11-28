import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { createConsole, validateConsoleConfig } from './console-server.mjs';
import { createDesktopControlHandler, executeDesktopControl } from './desktop-control.mjs';
import { createDesktopSenderEngine } from './desktop-sender/engine.mjs';
import { acquireDesktopQueue } from './desktop-sender/delivery-lock.mjs';
import { DesktopReceipts } from './desktop-receipts.mjs';
import { TextDeliveryStore } from './text-delivery-store.mjs';
import { ReplyDeliveryControls } from '../packages/dsh-social-bridge-plugin/reply-delivery-controls.mjs';
import { publishRecovery } from './desktop-sender/operations.mjs';

const accountRef = 'a'.repeat(64),
  parentId = 'c'.repeat(64),
  key = 'wechat:private:peer';
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
async function until(check) {
  for (let n = 0; n < 300; n++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('HTTP desktop fixture timeout');
}
async function fixture(t, { applyStoppedOffscreenImpl, fetchImpl, additionalPeers = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-control-http-'));
  const configFile = path.join(root, 'config/wechatagent.json');
  const config = JSON.parse(fs.readFileSync('config/wechatagent.example.json', 'utf8'));
  config.wechat.whitelist = { private: ['peer', ...additionalPeers], groups: [] };
  config.input.typeText = true;
  write(configFile, config);
  fs.mkdirSync(path.join(root, 'roles'));
  fs.writeFileSync(path.join(root, 'roles', config.persona.default + '.md'), 'Fixture role');
  write(path.join(root, 'state/weflow/active-account.json'), { id: accountRef });
  const controlToken = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.join(root, 'state/desktop'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state/desktop/control.token'), controlToken);
  const readConfig = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const state = {
    draft: '',
    prepared: null,
    hold: true,
    strokes: [],
    submits: 0,
    factories: [],
    rows: [],
    restores: 0,
  };
  const permitted = job =>
    job.accountRef === accountRef &&
    job.kind === 'private' &&
    readConfig().wechat.whitelist.private.includes(job.target);
  const receipts = new DesktopReceipts(root, {
    messages: async () => ({ messages: state.rows, watermarks: {} }),
    authorize: permitted,
    recordingReceipt: async () => null,
  });
  const engine = createDesktopSenderEngine({
    root,
    config: readConfig,
    authorize: async job => ({ allowed: permitted(job), grantId: 'b'.repeat(64), version: 1 }),
    authorizeCurrent: permitted,
    resolveTarget: async (kind, target) => ({
      kind,
      wxid: target,
      name: 'Fixture',
      alias: 'fixture',
      uniqueSearchName: true,
    }),
    probeAccount: async () => ({
      account: 'self',
      accountDirectory: path.join(root, 'account'),
      accountWxid: 'self',
      accountRef,
    }),
    receipt: (...args) => receipts.observe(...args),
    driverFactory: async ({ settings }) => {
      state.factories.push(structuredClone(settings));
      return {
        health: async () => ({ ready: true }),
        prepare: async job => {
          state.prepared = job.id;
          return { ready: true };
        },
        observe: async job =>
          state.prepared === job.id
            ? {
                ready: true,
                account: job.account,
                target: job.target,
                foreground: true,
                idleMs: state.hold && state.strokes.length ? 0 : 99999,
                draft: state.draft,
                editorToken: 'editor',
                activityRevision: 'stable',
              }
            : { ready: false },
        typeGrapheme: async (_job, guard, local) => {
          assert.equal(local.canInput(), true);
          state.draft += guard.text;
          state.strokes.push(guard.text);
          return { performed: true, attempted: true };
        },
        pasteText: async (_job, guard, local) => {
          assert.equal(local.canInput(), true);
          state.draft += guard.text;
          state.strokes.push(guard.text);
          return { performed: true, attempted: true };
        },
        submit: async (_job, _guard, local) => {
          assert.equal(local.canSubmit(), true);
          state.rows.push({
            sourceShard: 'a'.repeat(64),
            isSend: 1,
            localType: 1,
            localId: ++state.submits,
            serverId: String(1000 + state.submits),
            createTime: Math.floor(Date.now() / 1000),
            fullText: state.draft,
          });
          state.draft = '';
          return { performed: true, attempted: true };
        },
        releaseTextFocus: async () => ({ released: true }),
        close: async () => {},
      };
    },
  });
  const textDeliveries = new TextDeliveryStore(path.join(root, 'state/text-deliveries'));
  const adapter = {
    directory: root,
    accountRef,
    project: readConfig(),
    textDeliveries,
    desktopSender: { engine: async () => engine },
    reload() {
      this.project = readConfig();
    },
    allowed(kind, target) {
      return kind === 'private' && this.project.wechat.whitelist.private.includes(target);
    },
  };
  const handler = createDesktopControlHandler({
    token: controlToken,
    projectRoot: root,
    execute: body => executeDesktopControl(adapter, body),
  });
  const controlServer = http.createServer((req, res) => {
    if (!handler(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise(resolve => controlServer.listen(0, '127.0.0.1', resolve));
  config.ports.adapter = controlServer.address().port;
  write(configFile, config);
  const app = createConsole({
    readLocalContacts: async () => ({
      account: accountRef,
      since: 100,
      contacts: [{ username: 'room@chatroom', canSend: true, heads: { ['a'.repeat(64)]: '1' } }],
    }),
    root,
    port: 0,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(applyStoppedOffscreenImpl ? { applyStoppedOffscreenImpl } : {}),
    restoreDesktopWindowImpl: async ({ assertStopped }) => {
      assert.equal(await assertStopped(), true);
      state.restores++;
      return { state: 'restored', released: true, parked: false };
    },
  });
  const address = await app.start(),
    base = 'http://127.0.0.1:' + address.port,
    { token } = await fetch(base + '/api/info').then(r => r.json());
  t.after(async () => {
    app.close();
    controlServer.closeAllConnections();
    await new Promise(resolve => controlServer.close(resolve));
    await engine.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const rpc = async (route, body, headers = {}) => {
    const response = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'X-Console-Token': token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  const controls = new ReplyDeliveryControls(root, accountRef);
  controls.register(key, 'legacy', [{ deliveryId: parentId, text: 'ab', state: 'queued' }]);
  controls.claim(key, 'legacy', parentId);
  const operation = textDeliveries.key('private', 'peer', parentId, 'ab');
  const admit = () =>
    engine.admit('text', {
      account: 'self',
      accountRef,
      accountWxid: 'self',
      kind: 'private',
      target: 'peer',
      deliveryId: operation,
      parentId,
      rosterGrant: 'legacy',
      text: 'ab',
    });
  return { root, state, engine, configFile, rpc, controlServer, controlToken, admit };
}

test('the console confirms an explicitly selected cache entry within the selected chat and account', async t => {
  const calls = [];
  const id = 'e'.repeat(64);
  const f = await fixture(t, {
    fetchImpl: async (url, request) => {
      assert.equal(new URL(url).hostname, '127.0.0.1');
      assert.equal(new URL(url).pathname, '/api/v1/files/' + id + '/confirm');
      assert.equal(request.headers.Authorization, 'Bearer fixture-reader');
      calls.push(JSON.parse(request.body));
      return Response.json({ status: 'confirmed', id, name: 'fixture.txt' });
    },
  });
  write(path.join(f.root, 'state/wechat-io-config.json'), { reader_token: 'fixture-reader' });
  const source = path.join(f.root, 'account/msg/file/fixture.txt');
  const route = '/api/received-file/confirm';
  assert.equal((await f.rpc(route, { key: 'wechat:private:other', id, path: source })).status, 403);
  assert.equal((await f.rpc(route, { key, id, path: 'fixture.txt' })).status, 400);
  assert.deepEqual(calls, []);
  assert.deepEqual(await f.rpc(route, { key, id, path: source }), {
    status: 200,
    data: { id, name: 'fixture.txt' },
  });
  assert.deepEqual(calls, [{ account: accountRef, grant: 'legacy', key, path: source }]);
});

test('console HTTP controls the actual entered native queue and safely applies a saved strategy afterward', async t => {
  const f = await fixture(t);
  await f.admit();
  f.engine.kick();
  await until(() => f.state.strokes.length === 1 && !f.engine.activeJob);
  const listing = await f.rpc('/api/chat-deliveries?key=' + key);
  assert.equal(listing.status, 200, JSON.stringify(listing.data));
  assert.equal(listing.data.replies.length, 0);
  assert.equal(listing.data.native.length, 1);
  let job = listing.data.native[0];
  assert.equal(job.parentId, parentId);
  assert.equal(job.inputStarted, true);
  assert.equal(job.canPause, true);
  assert.equal(job.preview, 'ab');
  // Give the waiting executor several observations before using the displayed command.
  await new Promise(resolve => setTimeout(resolve, 200));
  const control = (operation, row = job) =>
    f.rpc('/api/chat-deliveries/control', {
      operation,
      channel: 'native',
      account: accountRef,
      key,
      grant: 'legacy',
      id: row.id,
      revision: row.revision,
    });
  assert.equal((await control('pause')).status, 200);
  assert.equal((await control('cancel')).status, 409);
  const current = (await f.rpc('/api/config')).data;
  current.config.input.controlMode = 'uia';
  current.config.input.offscreen = true;
  assert.doesNotThrow(() => validateConsoleConfig(current.config, f.root));
  const save = await f.rpc('/api/config', { config: current.config, revision: current.revision });
  assert.equal(save.status, 200, JSON.stringify(save.data));
  assert.equal(save.data.desktopApply.pending, true);
  assert.equal(f.state.factories.length, 1);
  assert.equal((await f.rpc('/api/input-operations')).data.configuration.pending, true);
  job = (await f.rpc('/api/chat-deliveries?key=' + key)).data.native[0];
  f.state.hold = false;
  assert.equal((await control('resume', job)).status, 200);
  await until(() => f.state.submits === 1 && !f.engine.configurationPending && !f.engine.applying);
  assert.deepEqual(f.state.strokes, ['a', 'b']);
  assert.equal(f.state.factories.at(-1).controlMode, 'uia');
  assert.equal(f.state.factories.at(-1).offscreen, true);
  assert.equal((await f.rpc('/api/input-operations')).data.configuration.applied, true);
});

test('console HTTP can control an admitted reply while a different chat is still admitting', async t => {
  const other = 'other_peer';
  const f = await fixture(t, { additionalPeers: [other] });
  const config = JSON.parse(fs.readFileSync(f.configFile, 'utf8'));
  config.input.paused = true;
  write(f.configFile, config);
  const { row } = await f.admit();
  const scope = { accountRef, kind: 'private', target: 'peer', rosterGrant: 'legacy' };
  const current = () => f.engine.listDeliveries(scope)[0];
  const control = (operation, revision, chatKey = key, id = row.job.id) =>
    f.rpc('/api/chat-deliveries/control', {
      channel: 'native',
      account: accountRef,
      key: chatKey,
      grant: scope.rosterGrant,
      id,
      revision,
      operation,
    });

  const gate = Promise.withResolvers();
  const probe = f.engine.probeAccount;
  let waiting = false;
  f.engine.probeAccount = async options => {
    if (options.request.target === other) {
      waiting = true;
      await gate.promise;
    }
    return probe(options);
  };
  const admission = f.engine.request(
    'text',
    { ...row.job, target: other, parentId: undefined, deliveryId: 'other-admission', text: 'other reply' },
    { admissionOnly: true },
  );
  let work, timer;
  try {
    await until(() => waiting);
    work = (async () => {
      const initialRevision = current().revision;
      assert.equal((await control('cancel', initialRevision, 'wechat:private:' + other)).status, 409);
      assert.equal((await control('cancel', initialRevision, key, 'd'.repeat(64))).status, 409);
      assert.equal((await control('pause', initialRevision)).status, 200);
      assert.equal(current().state, 'paused');
      assert.equal((await control('cancel', initialRevision)).status, 409);
      assert.equal((await control('resume', current().revision)).status, 200);
      assert.equal((await control('cancel', current().revision)).status, 200);
      return true;
    })();
    const timeout = new Promise(resolve => {
      timer = setTimeout(resolve, 2500, false);
    });
    const finished = await Promise.race([work, timeout]);
    assert.equal(finished, true, 'an unrelated admission stalled controls for the saved reply');
    assert.equal(current().state, 'cancelled');
    f.state.hold = false;
    config.input.paused = false;
    write(f.configFile, config);
    f.engine.kick();
    await f.engine.pumping;
    assert.deepEqual(f.state.strokes, []);
    assert.equal(f.state.submits, 0);
  } finally {
    clearTimeout(timer);
    gate.resolve();
    await Promise.allSettled([admission, work]);
  }
  assert.equal((await admission).deliveryId, 'other-admission');
  await until(() => f.state.submits === 1);
  assert.equal(f.state.rows[0].fullText, 'other reply');
});

test('an older active job remains visible and controllable after 128 newer finished jobs', async t => {
  const f = await fixture(t);
  const { context, row } = await f.admit();
  // Fill the recent-history page after the oldest unsent task.
  for (let index = 1; index <= 128; index++) {
    const id = index.toString(16).padStart(64, '0');
    context.store.save({
      ...row,
      job: { ...row.job, id, deliveryId: id, parentId: id },
      createdAt: row.createdAt + index,
      sequence: row.sequence + index,
      admissionError: 'DESKTOP_ADMISSION_FAILED',
    });
  }
  const scope = { accountRef, kind: 'private', target: 'peer', rosterGrant: 'legacy' };
  assert.equal(
    f.engine.listDeliveries(scope).some(job => job.id === row.job.id),
    true,
  );
  const control = (operation, revision) =>
    f.rpc('/api/chat-deliveries/control', {
      channel: 'reply',
      account: accountRef,
      key,
      grant: 'legacy',
      operation,
      revision,
    });
  f.state.hold = false;
  assert.equal((await control('pause', 0)).status, 200);
  f.engine.kick();
  await f.engine.pumping;
  assert.deepEqual(f.state.strokes, []);
  assert.equal((await control('resume', 1)).status, 200);
  await until(() => f.state.submits === 1);
  assert.deepEqual(f.state.strokes, ['a', 'b']);
});

test(
  'control with the adapter unavailable waits for the stop check before editing saved jobs',
  { skip: process.platform !== 'win32' },
  async t => {
    const f = await fixture(t);
    const { context, row } = await f.admit();
    fs.unlinkSync(path.join(f.root, 'state/desktop/control.token'));
    write(path.join(f.root, 'state/runtime.json'), { adapter: { pid: process.pid } });
    fs.mkdirSync(path.join(f.root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'scripts/manage.ps1'), "Write-Output 'DESKTOP_RUNNING'\n");
    const response = await f.rpc('/api/chat-deliveries/control', {
      channel: 'native',
      account: accountRef,
      key,
      grant: 'legacy',
      id: row.job.id,
      revision: 0,
      operation: 'cancel',
    });
    assert.equal(response.status, 409);
    assert.match(response.data.error, /请先停止机器人/u);
    assert.equal(JSON.parse(fs.readFileSync(context.store.file(row.job.id), 'utf8')).cancelled, undefined);
  },
);

test('adapter control authenticates tokens and origin and rejects other accounts or revoked chats', async t => {
  const f = await fixture(t);
  await f.admit();
  const url = 'http://127.0.0.1:' + f.controlServer.address().port + '/desktop/control';
  const call = (body, headers = {}) =>
    fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + f.controlToken, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await call({ action: 'list', account: accountRef, key, grant: 'legacy' }, { Authorization: 'Bearer wrong' }))
      .status,
    403,
  );
  assert.equal(
    (await call({ action: 'list', account: accountRef, key, grant: 'legacy' }, { Origin: 'https://foreign.example' }))
      .status,
    403,
  );
  assert.equal((await call({ action: 'list', account: 'd'.repeat(64), key, grant: 'legacy' })).status, 403);
  assert.equal((await call({ action: 'send-text', text: 'not permitted' })).status, 400);
  const current = JSON.parse(fs.readFileSync(f.configFile, 'utf8'));
  current.wechat.whitelist.private = [];
  write(f.configFile, current);
  assert.equal((await call({ action: 'list', account: accountRef, key, grant: 'legacy' })).status, 403);
  assert.equal(f.state.strokes.length, 0);
});

test('real recovery HTTP succeeds only after the service check returns true and emergency restore uses the new facade', async t => {
  const f = await fixture(t),
    record = publishRecovery({
      root: f.root,
      accountRef,
      id: 'd'.repeat(64),
      kind: 'draft',
      reason: 'DESKTOP_FIXTURE_DRAFT',
      state: { draft: true },
    });
  const body = {
    account: accountRef,
    id: record.id,
    revision: record.revision,
    acknowledgeDraftCleared: true,
    acknowledgeOutcomeReviewed: true,
  };
  write(path.join(f.root, 'state/runtime.json'), { adapter: { pid: process.pid } });
  assert.equal((await f.rpc('/api/input-operations/recover', body)).status, 409);
  assert.equal((await f.rpc('/api/window-placement', { action: 'restore' })).status, 409);
  assert.equal(f.state.restores, 0);
  if (process.platform === 'win32') {
    fs.mkdirSync(path.join(f.root, 'scripts'), { recursive: true });
    fs.copyFileSync(new URL('./manage.ps1', import.meta.url), path.join(f.root, 'scripts/manage.ps1'));
    write(path.join(f.root, 'state/runtime.json'), {
      adapter: {
        pid: process.pid,
        exe: path.join(f.root, 'obsolete.exe'),
        marker: path.join(f.root, 'old-adapter.mjs'),
        createdUtcTicks: '1',
      },
    });
  } else fs.unlinkSync(path.join(f.root, 'state/runtime.json'));
  const lease = acquireDesktopQueue(f.root);
  assert(lease);
  try {
    assert.equal((await f.rpc('/api/input-operations/recover', body)).status, 409);
    assert.equal((await f.rpc('/api/input-operations')).data.recoveries[0].id, record.id);
  } finally {
    lease.release();
  }
  const recovered = await f.rpc('/api/input-operations/recover', body);
  assert.equal(recovered.status, 200, JSON.stringify(recovered.data));
  assert.deepEqual(recovered.data.recoveries, []);
  assert.equal((await f.rpc('/api/window-placement', { action: 'restore' })).status, 200);
  assert.equal(f.state.restores, 1);
  assert.equal((await f.rpc('/api/window-placement', { action: 'park' })).status, 400);
  assert.equal(f.state.strokes.length, 0);
});

test('saving offscreen while stopped immediately applies or restores the window without starting the executor', async t => {
  const placements = [];
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = await fixture(t, {
    applyStoppedOffscreenImpl: async ({ config, assertStopped }) => {
      assert.equal(await assertStopped(), true);
      const enabled = config.input.offscreen === true;
      placements.push(enabled);
      if (enabled) {
        started.resolve();
        await release.promise;
        assert.equal(await assertStopped(), true);
      }
      return { available: true, applied: true, windowState: { parked: enabled, restored: !enabled } };
    },
  });
  fs.unlinkSync(path.join(f.root, 'state/desktop/control.token'));
  let { config, revision } = (await f.rpc('/api/config')).data;
  Object.assign(config.input, { controlMode: 'uia', offscreen: true });
  const pending = f.rpc('/api/config', { config, revision });
  try {
    await Promise.race([
      started.promise,
      pending.then(result => assert.fail('Stopped placement did not start: ' + JSON.stringify(result))),
    ]);
    const latest = (await f.rpc('/api/config')).data;
    Object.assign(latest.config.input, { controlMode: 'ocr', offscreen: false });
    const competing = await f.rpc('/api/config', latest);
    assert.equal(competing.status, 409);
    assert.match(competing.data.error, /有操作正在进行/);
    assert.equal((await f.rpc('/api/config')).data.config.input.offscreen, true);
  } finally {
    release.resolve();
  }
  const parked = await pending;
  assert.equal(parked.status, 200, JSON.stringify(parked.data));
  assert.equal(parked.data.desktopApply.windowState.parked, true);
  ({ config, revision } = parked.data);
  Object.assign(config.input, { controlMode: 'ocr', offscreen: false });
  const restored = await f.rpc('/api/config', { config, revision });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.equal(restored.data.desktopApply.windowState.restored, true);
  assert.deepEqual(placements, [true, false]);
  assert.equal(f.state.factories.length, 0);
  assert.deepEqual(f.state.strokes, []);
});

test('the unified roster HTTP save persists friends and groups without starting the sender or requesting restart', async t => {
  const f = await fixture(t),
    before = (await f.rpc('/api/chat-targets')).data;
  const saved = await f.rpc('/api/chat-targets', {
    account: before.account,
    revision: before.revision,
    targets: [
      { kind: 'private', id: 'peer' },
      { kind: 'group', id: 'room@chatroom' },
    ],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.deepEqual(saved.data.config.wechat.whitelist, { private: ['peer'], groups: ['room@chatroom'] });
  assert.notEqual(saved.data.pendingApply, true);
  assert.equal(f.state.factories.length, 0);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(f.configFile, 'utf8')).wechat.whitelist,
    saved.data.config.wechat.whitelist,
  );
});

test('a per-chat pause reaches already-admitted native work and continue releases that same queue', async t => {
  const f = await fixture(t);
  await f.admit();
  const hold = async (operation, revision) =>
    f.rpc('/api/chat-deliveries/control', {
      channel: 'reply',
      operation,
      account: accountRef,
      key,
      grant: 'legacy',
      revision,
    });
  assert.equal((await hold('pause', 0)).status, 200);
  const paused = (await f.rpc('/api/chat-deliveries?key=' + key)).data;
  assert.equal(paused.held, true);
  assert.equal(paused.native[0].state, 'paused');
  assert.equal(f.state.strokes.length, 0);
  f.state.hold = false;
  assert.equal((await hold('resume', 1)).status, 200);
  await until(() => f.state.submits === 1);
  assert.deepEqual(f.state.strokes, ['a', 'b']);
});

test('stopped Reader contact search and save use the selected full identity and keep other drafts intact', async t => {
  const peer = 'fixture-friend',
    peerId = peer,
    peerKey = 'wechat:private:' + peerId;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-roster-')),
    account = 'a'.repeat(64);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'));
  fs.cpSync(new URL('../roles/', import.meta.url), path.join(root, 'roles'), { recursive: true });
  fs.copyFileSync(
    new URL('../config/wechatagent.example.json', import.meta.url),
    path.join(root, 'config/wechatagent.json'),
  );
  fs.mkdirSync(path.join(root, 'state/weflow'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state/weflow/active-account.json'), JSON.stringify({ id: account }));
  fs.writeFileSync(path.join(root, 'state/wechat-io-config.json'), JSON.stringify({ reader_token: 'fixture' }));
  let searches = 0;
  const app = createConsole({
    root,
    port: 0,
    fetchImpl: async () => {
      throw new TypeError('offline', { cause: { code: 'ECONNREFUSED' } });
    },
    readLocalContacts: async (directory, _python, query) => {
      assert.equal(directory, root);
      if (query.ids) assert.deepEqual(query.ids, [peer]);
      else assert.deepEqual(query, { kind: 'private', keyword: 'Example' });
      searches++;
      return {
        account,
        since: 100,
        contacts: [
          {
            username: peer,
            displayName: 'Example',
            conversationId: peerId,
            canSend: true,
            heads: { ['a'.repeat(64)]: '1' },
          },
        ],
      };
    },
  });
  t.after(() => app.close());
  const url = 'http://127.0.0.1:' + (await app.start()).port;
  const { token } = await (await fetch(url + '/api/info')).json(),
    headers = { 'x-console-token': token, 'content-type': 'application/json' };
  const { contacts } = await (await fetch(url + '/api/contacts?kind=private&keyword=Example', { headers })).json();
  assert.equal(searches, 1);
  assert.equal(contacts[0].id, peer);
  const before = await (await fetch(url + '/api/chat-targets', { headers })).json();
  const response = await fetch(url + '/api/chat-targets', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      account,
      revision: before.revision,
      targets: [{ kind: 'private', id: contacts[0].id }],
    }),
  });
  const after = await response.json();
  assert.equal(response.status, 200, JSON.stringify(after));
  assert.deepEqual(after.config.wechat.whitelist.private, [peer]);
});
