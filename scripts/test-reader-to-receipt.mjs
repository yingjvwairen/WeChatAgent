import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { HistoryStore } from '../packages/dsh-social-bridge-plugin/history-store.mjs';
import { WechatOneBot } from './wechat-onebot.mjs';
import { createDesktopSenderEngine } from './desktop-sender/engine.mjs';

const project = path.resolve(import.meta.dirname, '..');
// Keep the Reader's SQL, fresh snapshots, inbox and HTTP protocol. Supply a
// plain SQLite shard and a synthetic contact in place of an installed account.
const pythonFixture = String.raw`
import importlib.util, json, sqlite3, sys, threading, time
from collections import OrderedDict
from pathlib import Path

scripts, root, scope, token = sys.argv[1:]
sys.path.insert(0, scripts)
spec = importlib.util.spec_from_file_location('reader', Path(scripts) / 'reader-api.py')
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)
reader = api.Reader.__new__(api.Reader)
reader.root, reader.account_ref = Path(root), scope
reader.account, reader.own_wxid = reader.root / 'test_account', 'test_owner'
reader.names = {'test_peer': 'Test Peer'}
reader.desktop_targets = api.DesktopTargets([('test_peer', 'test_peer', '', 'Test Peer', 0)], reader.names, {}, complete=True)
reader.open_messages = lambda: [sqlite3.connect(reader.root / 'messages.sqlite')]
reader.refresh_names = reader.pump_sticker_collection = reader.pump_sticker_pool_review = lambda **_: None
reader.sticker_account_active = lambda: True
reader.intake = api.ReaderIntake(reader.root, scope)
reader.started_at, reader.last_poll, reader.last_intake_request, reader.pushed = int(time.time()), 0, 0, 0
reader.image_error = reader.group_metadata_error = reader.last_error = ''
reader.image_index, reader.seen = {}, OrderedDict()
reader.consumer_session, reader.consumer_lock = None, threading.Lock()
reader.retired_consumer_clients = set()
reader.lock, reader.stop = threading.Lock(), threading.Event()
reader.receipt_connections = api.ReceiptConnections(lambda: [reader.root / 'messages.sqlite'], reader.open_messages)
with api.create_reader_server(0, api.reader_request_handler(reader, token)) as server:
    threading.Thread(target=reader.poll, daemon=True).start()
    print(json.dumps({'port': server.server_address[1]}), flush=True)
    server.serve_forever()
`;

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

test(
  'Reader rows traverse actual OneBot and bridge entry points and the desktop queue waits for a database receipt',
  { timeout: 40000 },
  async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-reader-to-receipt-'));
    const peer = 'test_peer',
      self = 'test_owner',
      key = 'wechat:private:' + peer,
      accountRef = 'a'.repeat(64),
      grant = 'fixture-grant',
      token = 'b'.repeat(64);
    const requests = [],
      receiptChecks = [],
      logs = {},
      children = [];
    let adapter, model, engine;
    const db = new DatabaseSync(path.join(root, 'messages.sqlite'));
    const history = new HistoryStore(root, accountRef);
    t.after(async () => {
      try {
        if (adapter) await adapter.stop();
        else await engine?.close();
      } finally {
        for (const child of children) {
          if (child.exitCode !== null || child.signalCode !== null) continue;
          const closed = once(child, 'close');
          if (child.kill()) await closed;
        }
        model?.closeAllConnections();
        if (model?.listening) await new Promise(resolve => model.close(resolve));
        db.close();
        history.close();
        assert.equal(path.dirname(root), os.tmpdir());
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
    const start = (name, command, args, extra = {}) => {
      const child = spawn(command, args, {
        cwd: project,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...extra,
      });
      logs[name] = '';
      child.on('error', error => (logs[name] += error.message));
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => (logs[name] += chunk));
      children.push(child);
    };
    const wait = async (read, label) => {
      for (let i = 0; i < 220; i++) {
        const value = await read();
        if (value) return value;
        await delay(35);
      }
      assert.fail(label + '\n' + JSON.stringify({ logs, adapter: adapter?.status, requests: requests.length }));
    };
    const write = (relative, value) => {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(value));
    };

    const table = 'Msg_' + createHash('md5').update(peer).digest('hex');
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('CREATE TABLE Name2Id(user_name TEXT)');
    for (const name of [peer, self]) db.prepare('INSERT INTO Name2Id VALUES (?)').run(name);
    db.exec(
      'CREATE TABLE "' +
        table +
        '"(local_id INTEGER PRIMARY KEY, server_id TEXT, local_type INTEGER, real_sender_id INTEGER, create_time INTEGER, message_content TEXT)',
    );
    const insert = db.prepare('INSERT INTO "' + table + '" VALUES(?, ?, 1, ?, ?, ?)');

    const reservation = net.createServer();
    const onebotPort = await listen(reservation);
    await new Promise(resolve => reservation.close(resolve));
    const wechat = {
      enabled: true,
      whitelist: { groups: [], private: [peer] },
      rosterGrants: { [key]: grant },
      wake_mode: 'hybrid',
      stickers: { enabled: false },
      search: { enabled: false },
      onebot: { server: { port: onebotPort, path: '/ws' } },
    };
    const config = {
      runtime: { sender: 'wechat-ui' },
      ports: { adapter: 0 },
      input: { controlMode: 'ocr', idleMs: 0, receiptTimeoutMs: 8000, operationTimeoutMs: 5000 },
      wechat,
    };
    write('config/wechatagent.json', config);
    write('state/weflow/active-account.json', { id: accountRef });
    start('reader', process.env.WECHATAGENT_TEST_PYTHON || 'python', [
      '-B',
      '-c',
      pythonFixture,
      path.join(project, 'scripts'),
      root,
      accountRef,
      token,
    ]);
    const readerPort = (await wait(() => /"port": (\d+)/.exec(logs.reader), 'Reader failed to start'))[1];
    write('state/wechat-io-config.json', {
      reader_base_url: 'http://127.0.0.1:' + readerPort,
      reader_token: token,
      onebot_ws_url: 'ws://127.0.0.1:' + onebotPort + '/ws',
    });

    model = http.createServer(async (req, res) => {
      if (req.headers.authorization !== 'Bearer ' + token) return res.writeHead(401).end();
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/health')
        return res.end(
          JSON.stringify({
            ok: true,
            project: 'WeChatAgent',
            projectRoot: root,
            contextMode: 'native-session-v1',
            instanceId: 'test-model',
            accountScope: accountRef,
          }),
        );
      if (req.url !== '/followup') return res.writeHead(404).end();
      const body = [];
      for await (const chunk of req) body.push(chunk);
      requests.push(JSON.parse(Buffer.concat(body).toString('utf8')));
      res.end(JSON.stringify({ text: 'RESPOND: fixture reply' }));
    });
    const modelPort = await listen(model);
    const buffer = path.join(root, 'messages.json');
    write('bridge.json', {
      project_root: root,
      platforms: { wechat },
      dsh_plugin: { url: 'http://127.0.0.1:' + modelPort, timeoutMs: 3000 },
      message_buffer: { path: buffer },
      social: { batch_ms: 10 },
      role: 'Test Persona',
    });
    start(
      'bridge',
      process.execPath,
      [path.join(project, 'components/qq-bridge/src/social-bridge.js'), path.join(root, 'bridge.json')],
      { env: { ...process.env, SOCIAL_DSH_TOKEN: token } },
    );
    await wait(() => logs.bridge.includes('reverse OneBot listening'), 'Bridge failed to start');

    const account = {
      account: 'test_account',
      accountWxid: self,
      accountRef,
      accountDirectory: path.join(root, 'test_account'),
    };
    const desktopSender = {
      request: (operation, payload) => engine.request(operation, payload),
      resumePending: () => engine.start(),
      close: () => engine.close(),
    };
    adapter = new WechatOneBot({ directory: root, desktopSender });
    let draft = '',
      submissions = 0;
    engine = createDesktopSenderEngine({
      root,
      config,
      probeAccount: async () => account,
      resolveTarget: (kind, target) => adapter.resolveDesktopTarget(kind, target),
      authorize: (job, options) => adapter.authorizeDesktop(job, options),
      authorizeCurrent: (job, forInput) => adapter.authorizeDesktopCurrent(job, forInput),
      receipt: async (job, request) => {
        assert.equal(job.accountRef, accountRef);
        assert.equal(job.rosterGrant, grant);
        const result = await adapter.desktopReceipt(job, request);
        if (request.phase === 'query') receiptChecks.push(result);
        return result;
      },
      driverFactory: async () => ({
        health: async () => ({
          ready: true,
          backend: 'wechat-ui',
          version: '4.2.0.53',
          databaseAccounts: [account.account],
        }),
        prepare: async () => ({ ready: true }),
        observe: async job => ({
          ready: true,
          account: job.account,
          target: job.target,
          foreground: true,
          idleMs: 99999,
          draft,
          editorToken: 'test-editor',
          activityRevision: 'test-activity',
        }),
        pasteText: async (_job, guard) => {
          draft += guard.text;
          return { performed: true, attempted: true };
        },
        submit: async (job, _guard, local) => {
          assert.equal(local.canSubmit(), true);
          assert.equal(job.target, peer);
          insert.run(2, '0', 2, Math.floor(Date.now() / 1000), draft);
          draft = '';
          submissions++;
          return { performed: true, attempted: true };
        },
        close: async () => {},
      }),
    });
    await adapter.start();
    await wait(async () => {
      const status = await adapter.reader('/api/v1/reader/status?progress=1');
      return adapter.status.reader_connected && status.intakeProgress.some(row => row.key === key);
    }, 'Reader and bridge did not establish an intake boundary');
    history.db.exec(`CREATE TRIGGER fixture_archive_failure BEFORE INSERT ON records
      WHEN NEW.id LIKE 'message:%' BEGIN SELECT RAISE(FAIL, 'fixture archive unavailable'); END;`);
    insert.run(1, '201', 1, Math.floor(Date.now() / 1000), 'fixture question');
    await wait(() => submissions === 1, 'The model reply did not reach the desktop queue');
    assert.equal(adapter.status.received, 0, 'Reader acknowledgement must wait for the archive write');
    history.db.exec('DROP TRIGGER fixture_archive_failure');
    await wait(() => receiptChecks.length, 'The desktop executor did not query Reader for a receipt');
    assert.equal(receiptChecks[0].confirmed, false);
    assert.equal(adapter.status.confirmed_sends, 0, 'A provisional outgoing row cannot confirm delivery');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].conversationKey, key);
    assert.match(requests[0].message, /fixture question/);
    db.prepare('UPDATE "' + table + '" SET server_id=? WHERE local_id=2').run('9007199254740993');
    await wait(() => {
      const rows = JSON.parse(fs.readFileSync(buffer, 'utf8')).chats[key] ?? [];
      return rows.some(row => row.outgoing && row.delivery_status === 'confirmed' && row.text === 'fixture reply');
    }, 'The Reader receipt was not persisted by the bridge');
    // Reconnect to retry the intake without waiting for the first ACK timeout.
    adapter.socket.close();
    await wait(() => adapter.status.received === 1, 'Reader did not receive the durable intake acknowledgement');
    assert.equal(receiptChecks.find(row => row.confirmed).receipt.serverId, '9007199254740993');
    assert.equal(adapter.status.confirmed_sends, 1);
    assert.equal(submissions, 1);
    assert.equal(requests.length, 1, 'Retrying the archive must not schedule the reply again');
  },
);
