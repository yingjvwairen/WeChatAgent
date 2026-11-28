import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pcmWav, voicePcm } from './decode-wechat-voice.mjs';
import { WechatOneBot } from './wechat-onebot.mjs';
import { pcmWave } from './desktop-sender/engine-voice.mjs';
import { PluginInstaller } from '../packages/plugin-api/installer.mjs';
import { configuration, packageFiles, scanPlugins, updatePlugin } from '../packages/plugin-api/catalog.mjs';
import { packZip } from '../packages/plugin-api/zip.mjs';
import { createSettingsActionRunner } from './plugin-settings-actions.mjs';
import { ReverseOneBotServer } from '../components/qq-bridge/src/onebot/reverse-ws-server.js';
import { WechatOneBotAdapter } from '../components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js';
import { acceptanceVoiceSource, acceptVoiceDelivery } from './filehelper-acceptance.mjs';
import { selectPluginAccount } from './test-fixtures/plugin-account.mjs';

const token = 'b'.repeat(64),
  account = 'wxid_fixture_1234',
  chat = 'fixture@chatroom',
  target = 'filehelper';
const wav = pcmWav(Buffer.alloc(3200)),
  route = '/api/voice/send';
const row = (fields = {}) => ({
  localId: 2,
  localType: 34,
  isSend: 1,
  createTime: Math.floor(Date.now() / 1000),
  serverId: '900000000000000001',
  ...fields,
});
const segment = (id, index = 0, durationMs = 1000, serverId) => ({
  index,
  attemptId: crypto
    .createHash('sha256')
    .update(id + ':' + index)
    .digest('hex'),
  durationMs,
  state: serverId ? 'confirmed' : 'submitted',
  ...(serverId ? { serverId, localId: index + 2, source: 'desktop-acoustic-match' } : {}),
});
async function fixture(t, { capable = true, receiptTimeoutMs = 30000, loseResponse = false, stream = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'WeChatAgent-voice-send-'));
  const config = {
    runtime: { sender: 'wechat-ui', weflowMode: 'nt' },
    input: { wechatExecutable: path.join(directory, 'Weixin.exe'), voiceSend: true },
    ports: { adapter: 0 },
    account: { nicknames: ['Fixture'] },
    wechat: { whitelist: { private: ['filehelper', 'wxid_other'], groups: ['fixture@chatroom'] } },
  };
  fs.mkdirSync(path.join(directory, 'config'));
  fs.mkdirSync(path.join(directory, 'state'));
  selectPluginAccount(directory);
  fs.writeFileSync(
    path.join(directory, 'state/wechat-io-config.json'),
    JSON.stringify({ reader_base_url: 'http://127.0.0.1:5031', reader_token: 'reader-token' }),
  );
  const tokenFile = path.join(directory, 'state/voice-send.token');
  fs.writeFileSync(tokenFile, token);
  const backend = {
    account,
    readerOwnWxid: 'wxid_fixture',
    chat: 'filehelper',
    voiceEnabled: capable,
    rows: [],
    targetRows: new Map(),
    submissions: [],
    textSubmissions: [],
    results: new Map(),
    loseVoice: loseResponse,
    autoConfirm: false,
    confirmLatest(server = '900000000000000001') {
      const sent = this.submissions.at(-1),
        result = this.results.get(sent.deliveryId);
      const segments = result.segments.map((part, index) =>
        segment(sent.deliveryId, index, part.durationMs, String(BigInt(server) + BigInt(index))),
      );
      this.results.set(sent.deliveryId, {
        ...result,
        state: 'confirmed',
        pending: false,
        confirmed: true,
        submitted: true,
        submission: 'confirmed',
        segments,
      });
    },
  };
  const sessions = [
    { username: 'filehelper', displayName: '文件传输助手' },
    { username: 'wxid_other', displayName: 'Fixture peer' },
    { username: chat, displayName: 'Fixture group' },
  ];
  const saveConfig = () => fs.writeFileSync(path.join(directory, 'config/wechatagent.json'), JSON.stringify(config));
  saveConfig();
  const inbox = (backend.inbox = []);
  backend.emitVoice = payload => {
    const rawid = crypto.createHash('sha256').update(payload.rawid).digest('hex');
    inbox.push({
      ...payload,
      rawid,
      readerIntake: {
        version: 1,
        rawid,
        token: crypto.randomBytes(32).toString('hex'),
        account: 'a'.repeat(64),
        grant: 'legacy',
      },
    });
  };
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    assert.equal(options.headers.Authorization, 'Bearer reader-token');
    if (url.pathname === '/api/v1/reader/status')
      return Response.json({
        backend: 'weflow-cli-nt',
        intakeProtocol: 'reader-inbox-v2',
        ownWxid: backend.readerOwnWxid,
        accountDirectory: backend.account,
        accountRef: 'a'.repeat(64),
      });
    if (url.pathname === '/api/v1/sessions') return Response.json({ sessions });
    if (url.pathname === '/api/v1/desktop-target') {
      const row = sessions.find(r => r.username === url.searchParams.get('target'));
      return Response.json({
        target: row && {
          wxid: row.username,
          name: row.displayName,
          searchName: row.displayName,
          uniqueSearchName: true,
          uniqueTitle: true,
          alias: '',
          account: backend.account.toLowerCase(),
          accountWxid: backend.readerOwnWxid,
          accountRef: 'a'.repeat(64),
        },
      });
    }
    if (url.pathname === '/api/v1/messages')
      return Response.json({
        messages:
          url.searchParams.get('talker') === 'filehelper'
            ? backend.rows
            : (backend.targetRows.get(url.searchParams.get('talker')) ?? []),
      });
    if (url.pathname === '/api/v1/intake/next') return Response.json({ event: inbox[0] ?? null });
    if (url.pathname === '/api/v1/intake/route') {
      const body = JSON.parse(options.body);
      const item = inbox.find(row => row.readerIntake.token === body.token);
      assert.equal(item.rawid, body.rawid);
      if (body.forward) item.readerIntake.route = 'dsh';
      return Response.json({ success: true, route: (item.readerIntake.route ??= body.route) });
    }
    if (url.pathname === '/api/v1/intake/ack') {
      if (backend.reconnectBeforeAck) {
        backend.reconnectBeforeAck = false;
        inbox[0].offlineReplay = 'reply';
        return Response.json({ success: false }, { status: 503 });
      }
      assert.equal(JSON.parse(options.body).token, inbox[0].readerIntake.token);
      inbox.shift();
      return Response.json({ success: true });
    }
    if (url.pathname.startsWith('/api/v1/voices/'))
      return Response.json({
        id: url.pathname.split('/').at(-1),
        conversationKey: url.searchParams.get('conversationKey'),
        b64: wav.toString('base64'),
        sha256: crypto.createHash('sha256').update(wav).digest('hex'),
        mime: 'audio/wav',
        filename: 'voice.wav',
        durationSeconds: 0.1,
      });
    assert.fail('Unexpected Reader route ' + url.pathname);
  };
  const desktopSender = {
    async request(operation, payload) {
      if (operation === 'health')
        return {
          backend: 'wechat-ui',
          version: '4.2.0.53',
          databaseAccounts: [backend.account],
          ready: true,
          paused: backend.paused === true,
          voiceSend: backend.voiceEnabled,
          controlMode: 'uia',
        };
      if (operation === 'lookup') return backend.results.get(payload.deliveryId) ?? null;
      if (operation === 'query') {
        const value = backend.results.get(payload.deliveryId);
        assert(value, 'query must refer to a prior logical operation');
        return value;
      }
      if (operation === 'text') {
        if (backend.interruptTextAdmission) {
          backend.interruptTextAdmission = false;
          throw Error('fixture interruption before desktop admission');
        }
        backend.textSubmissions.push(payload);
        const messages = backend.targetRows.get(payload.target) || [];
        messages.push(
          row({
            localType: 1,
            localId: 100 + backend.textSubmissions.length,
            serverId: String(910000000000000000n + BigInt(backend.textSubmissions.length)),
            content: payload.text,
          }),
        );
        backend.targetRows.set(payload.target, messages);
        const { localId, serverId } = messages.at(-1);
        const result = {
          deliveryId: payload.deliveryId,
          operation,
          ret: 0,
          admitted: true,
          state: 'confirmed',
          confirmed: true,
          pending: false,
          submitted: true,
          submission: 'confirmed',
          receipt: { source: 'wechat-server-id', localId, serverId },
        };
        backend.results.set(payload.deliveryId, result);
        return result;
      }
      assert.equal(operation, 'voice');
      assert(!backend.results.has(payload.deliveryId), 'logical operation submitted twice');
      backend.submissions.push(payload);
      const durationMs = Buffer.from(payload.pcmBase64, 'base64').length / 32;
      let result = {
        deliveryId: payload.deliveryId,
        state: 'submitted',
        admitted: true,
        pending: true,
        submitted: true,
        submission: 'submitted',
        confirmed: false,
        segments: Array.from({ length: Math.ceil(durationMs / 8000) }, (_, index) =>
          segment(payload.deliveryId, index, Math.min(8000, durationMs - index * 8000)),
        ),
      };
      if (backend.nextResult) result = { ...result, ...backend.nextResult };
      backend.results.set(payload.deliveryId, result);
      if (backend.loseVoice) {
        backend.results.set(payload.deliveryId, {
          ...result,
          state: 'unconfirmed',
          pending: false,
          submission: 'unknown',
          segments: result.segments.map(p => ({ ...p, state: 'unknown' })),
        });
        throw Object.assign(Error('DESKTOP_SEND_UNCONFIRMED'), { attempted: true });
      }
      if (backend.autoConfirm) {
        backend.confirmLatest();
        result = backend.results.get(payload.deliveryId);
      }
      return result;
    },
    async resumePending() {
      return [];
    },
    async close() {},
  };
  let adapter;
  const restart = async () => {
    if (adapter) await adapter.stop();
    adapter = new WechatOneBot({ directory, fetchImpl, receiptTimeoutMs, desktopSender });
    adapter.connectOneBot = async () => {
      adapter.readerConsumer = crypto.randomBytes(16).toString('hex');
      adapter.socket = {
        readyState: WebSocket.OPEN,
        close() {
          this.readyState = WebSocket.CLOSED;
        },
        send(raw) {
          const event = JSON.parse(raw),
            intake = event.wechatagent.readerIntake;
          void adapter.action({ action: 'ack_wechatagent_intake', params: { ...intake, self_id: event.self_id } });
        },
      };
    };
    if (!stream) adapter.receiveReaderInbox = async () => {};
    await adapter.start();
  };
  t.after(async () => {
    if (adapter) await adapter.stop();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await restart();
  const call = async (url, { auth = token, body } = {}) => {
    const response = await fetch('http://127.0.0.1:' + adapter.server.address().port + url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { http: response.status, body: await response.json() };
  };
  const submit = (overrides = {}, options) =>
    call(route, {
      ...options,
      body: {
        deliveryId: 'fixture-id',
        conversationKey: 'wechat:private:filehelper',
        wavBase64: wav.toString('base64'),
        ...overrides,
      },
    });
  return {
    backend,
    config,
    saveConfig,
    restart,
    submit,
    call,
    directory,
    tokenFile,
    status: (id = 'fixture-id') => call(route + '/' + id),
    adapter: () => adapter,
  };
}

test('voice API requires its token, live capability and permitted conversation before submitting', async t => {
  const f = await fixture(t);
  assert.equal((await f.submit({}, { auth: 'wrong' })).http, 401);
  assert((await f.submit({ conversationKey: 'wechat:private:999' })).http >= 400);
  assert.equal(f.backend.submissions.length, 0);
  f.backend.voiceEnabled = false;
  assert((await f.submit()).http >= 400);
  assert.equal(f.backend.submissions.length, 0);
});
test('File Transfer exposes normal voice capability and still queries a submitted operation only once', async t => {
  const f = await fixture(t);
  f.adapter().voiceSend.synthesis.candidates = () => [{ id: 'fixture', generation: '1' }];
  assert.equal((await f.adapter().voiceSend.capability('private', 'filehelper')).voice, true);
  assert.equal((await f.adapter().realtime.capability('private', 'filehelper')).voice, true);
  assert.equal((await f.adapter().realtime.capability('private', 'wxid_other')).voice, true);
  assert.equal((await f.adapter().realtime.capability('group', 'fixture@chatroom')).voice, true);
  assert.equal((await f.submit()).body.status, 'pending');
  const operation = f.backend.submissions[0].deliveryId;
  assert.equal(f.backend.submissions[0].target, 'filehelper');
  assert.equal((await f.submit()).body.status, 'pending');
  assert.equal(f.backend.submissions.length, 1);
  f.backend.confirmLatest();
  const result = await f.status();
  assert.equal(result.body.status, 'confirmed');
  assert.equal(f.adapter().voiceSend.load('fixture-id').operationId, operation);
  assert.equal(f.backend.submissions.length, 1);
});
test('a pending logical operation confirms only from its acoustic segment receipt and never resubmits', async t => {
  const f = await fixture(t);
  const initial = await f.submit();
  assert.equal(initial.body.status, 'pending');
  assert.equal(f.backend.submissions.length, 1);
  assert.equal(Buffer.from(f.backend.submissions[0].pcmBase64, 'base64').length, 32000);
  f.backend.confirmLatest();
  const confirmed = await f.status();
  assert.equal(confirmed.body.status, 'confirmed');
  assert.equal(confirmed.body.receiptSource, 'desktop-acoustic-match');
  await f.restart();
  assert.equal((await f.submit()).body.status, 'confirmed');
  assert.equal(f.backend.submissions.length, 1);
});

test('OneBot can still admit a voice while all desktop input is paused', async t => {
  const f = await fixture(t);
  f.backend.paused = true;
  f.backend.nextResult = { state: 'queued', submitted: false, submission: 'not-started', segments: [] };
  const voice = f.adapter().voiceSend;
  voice.synthesis.candidates = () => [{ id: 'fixture', generation: '1' }];
  assert.equal((await voice.capability('private', 'filehelper')).voice, true);
  assert.equal((await f.submit()).body.status, 'pending');
  assert.equal(f.backend.submissions.length, 1);
  const job = voice.load('fixture-id');
  voice.save({ ...job, deadline: Date.now() - 1 });
  assert.equal((await f.status()).body.status, 'pending');
  f.backend.paused = false;
  const { deliveryId } = f.backend.submissions[0];
  f.backend.results.get(deliveryId).segments = [segment(deliveryId, 0, 1000)];
  f.backend.confirmLatest();
  assert.equal((await f.status()).body.status, 'confirmed');
  assert.equal(f.backend.submissions.length, 1);
});

test('an automated voice binds the original roster grant and can queue behind a different send', async t => {
  const f = await fixture(t);
  const adapter = f.adapter();
  const key = 'wechat:private:filehelper';
  const grant = 'old-grant';
  f.config.wechat.rosterGrants = { [key]: grant };
  f.saveConfig();
  const originalCheck = adapter.checkNative.bind(adapter);
  adapter.checkNative = async () => {
    const identity = await originalCheck();
    f.config.wechat.rosterGrants[key] = 'new-grant';
    f.saveConfig();
    return identity;
  };
  let syntheses = 0;
  const selected = { id: 'fixture', generation: 'current' };
  Object.assign(adapter.voiceSend.synthesis, {
    selected: () => selected,
    candidates: () => [selected],
    generate: async () => {
      syntheses++;
      return { wav, allowed: () => true };
    },
  });
  const bridge = new WechatOneBotAdapter();
  bridge.server.action = async (action, params) => {
    const reply = await adapter.action({ action, params });
    assert.equal(reply.status, 'ok', reply.message);
    return reply;
  };
  const request = { kind: 'private', target, text: '合成夹具', deliveryId: 'a'.repeat(64) };
  const revoked = await bridge.sendVoiceText({ ...request, rosterGrant: grant });
  assert.deepEqual(revoked, { status: 'rejected', fallback: false, error: 'VOICE_CONVERSATION_GRANT_CHANGED' });
  assert.equal(syntheses, 0);
  assert.equal(f.backend.submissions.length, 0);

  adapter.targetsSending.add('private:wxid_other');
  const pending = await bridge.sendVoiceText({ ...request, rosterGrant: 'new-grant' });
  assert.deepEqual(pending, { status: 'pending', fallback: false });
  assert.equal(syntheses, 1);
  assert.equal(f.backend.submissions.length, 1);
  assert.equal(f.backend.submissions[0].rosterGrant, 'new-grant');
  f.backend.confirmLatest();
  const confirmed = await bridge.sendVoiceText({ ...request, rosterGrant: 'new-grant', receiptOnly: true });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(f.backend.submissions.length, 1);
});
test('filehelper acceptance uses production VoiceSend admission and aggregate query receipts', async t => {
  const f = await fixture(t);
  let waited = 0;
  const result = await acceptVoiceDelivery(
    f.adapter().voiceSend,
    { deliveryId: 'acceptance-fixture', kind: 'private', target: 'filehelper', wav: acceptanceVoiceSource().wav },
    {
      wait: async () => {
        waited++;
        f.backend.confirmLatest();
      },
    },
  );
  assert.equal(result.receiptSource, 'desktop-acoustic-match');
  assert.equal(result.segments.length, 1);
  assert.equal(waited, 1);
  assert.equal(f.backend.submissions.length, 1);
  assert.equal(f.backend.submissions[0].target, 'filehelper');
});
test('an interruption before voice admission reuses the original audio and operation ID after restart', async t => {
  const f = await fixture(t);
  const adapter = f.adapter(),
    original = adapter.dispatchDesktop.bind(adapter);
  let attempts = 0;
  adapter.dispatchDesktop = async (...args) => {
    if (++attempts === 1) throw Error('reader lookup interrupted');
    return original(...args);
  };
  const response = await f.submit();
  assert.equal(response.body.status, 'pending');
  assert.equal(f.backend.submissions.length, 0);
  const pending = adapter.voiceSend.load('fixture-id');
  assert(pending.pendingPcm);
  await f.restart();
  await f.status();
  assert.equal(f.backend.submissions.length, 1);
  assert.equal(f.backend.submissions[0].deliveryId, pending.operationId);
  assert.equal(f.backend.submissions[0].pcmBase64, pending.pendingPcm);
  assert.equal(f.adapter().voiceSend.load('fixture-id').pendingPcm, undefined);
  await f.status();
  assert.equal(f.backend.submissions.length, 1);
});
test('observing an interrupted voice never dispatches PCM that the desktop did not accept', async t => {
  const f = await fixture(t),
    adapter = f.adapter();
  adapter.dispatchDesktop = async () => {
    throw Error('interrupted before admission');
  };
  await f.submit();
  const job = adapter.voiceSend.load('fixture-id');
  assert(job.pendingPcm);
  const result = await adapter.voiceSend.status(job, null, true);
  assert.equal(result.status, 'rejected');
  assert.equal(f.backend.submissions.length, 0);
  assert.equal(adapter.voiceSend.load('fixture-id').pendingPcm, undefined);
});

test('a lost submission response survives restart and queries the same UUID without sending again', async t => {
  const f = await fixture(t, { loseResponse: true });
  await f.submit();
  const operation = f.backend.submissions[0].deliveryId;
  await f.restart();
  await f.submit();
  assert.equal(f.backend.submissions.length, 1);
  assert.equal(f.adapter().voiceSend.load('fixture-id').operationId, operation);
  f.backend.confirmLatest();
  assert.equal((await f.status()).body.status, 'confirmed');
  assert.equal(f.backend.submissions.length, 1);
});
test('claimed confirmation with no segments cannot confirm a logical voice', async t => {
  const f = await fixture(t);
  f.backend.nextResult = { state: 'confirmed', pending: false, submission: 'confirmed', confirmed: true, segments: [] };
  const result = await f.submit();
  assert.notEqual(result.body.status, 'confirmed');
  assert.equal(f.backend.submissions.length, 1);
});
test('long voice keeps confirmed earlier parts and unknown later parts without a text fallback', async t => {
  const f = await fixture(t);
  const parts = Array.from({ length: 9 }, (_, index) =>
    segment(
      'long',
      index,
      index === 8 ? 1000 : 8000,
      index < 8 ? String(900000000000000001n + BigInt(index)) : undefined,
    ),
  );
  parts[8].state = 'unknown';
  f.backend.nextResult = {
    state: 'unconfirmed',
    pending: false,
    submission: 'unknown',
    confirmed: false,
    segments: parts,
  };
  const result = await f.submit({ wavBase64: pcmWave(Buffer.alloc(32000 * 65).toString('base64')).toString('base64') });
  assert.notEqual(result.body.status, 'confirmed');
  assert.equal(result.body.segments.filter(part => part.state === 'confirmed').length, 8);
  assert.equal(result.body.segments.at(-1).state, 'unknown');
  assert.equal(f.backend.submissions.length, 1);
  assert.equal(f.backend.textSubmissions.length, 0);
  await f.restart();
  await f.status();
  assert.equal(f.backend.submissions.length, 1);
});

test('a cancelled later bubble after a confirmed segment is terminal and cannot fall back', async t => {
  const f = await fixture(t);
  const parts = [segment('partial', 0, 7500, '12345'), { ...segment('partial', 1, 1500), state: 'cancelled' }];
  f.backend.nextResult = {
    state: 'cancelled',
    pending: false,
    submission: 'submitted',
    confirmed: false,
    segments: parts,
  };
  const result = await f.submit();
  assert.equal(result.body.status, 'unconfirmed');
  assert.equal(result.body.submitted, true);
  assert.equal((await f.status()).body.status, 'unconfirmed');
  assert.equal(f.backend.submissions.length, 1);
});

test('the installed TTS plugin tests settings and submits normalized speech once per delivery', async t => {
  const f = await fixture(t, {});
  const calls = [];
  const providerWav = pcmWav(Buffer.alloc(24000 * 2 * 9));
  providerWav.writeUInt32LE(24000, 24);
  providerWav.writeUInt32LE(48000, 28);
  let providerStatus = 200,
    revoke;
  const provider = http.createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const transcribing = req.url.endsWith('/audio/transcriptions');
    calls.push({
      url: req.url,
      authorization: req.headers.authorization,
      body: body && !transcribing ? JSON.parse(body) : null,
    });
    if (transcribing) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ text: '转写测试通过。' }));
    }
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'team/tts' }, { id: 'fixture-key' }] }));
    }
    revoke?.();
    res.writeHead(providerStatus, { 'Content-Type': 'application/octet-stream' });
    res.end(providerWav);
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  });
  const source = path.join(import.meta.dirname, '..', 'optional-extensions', 'speech-synthesis');
  const installer = new PluginInstaller(f.directory);
  t.after(() => installer.dispose());
  const ticket = installer.inspect({
    name: 'speech-synthesis.zip',
    zip: packZip(packageFiles(source)).toString('base64'),
  });
  installer.install(ticket);
  const settings = {
    endpoint: 'http://127.0.0.1:' + provider.address().port + '/tenant/v1/audio/speech',
    apiKey: 'fixture-key',
    model: 'team/tts',
    voice: 'fixture-voice',
    recognitionModel: 'team/asr',
  };
  const set = (enabled, chats = ['wechat:private:filehelper']) =>
    updatePlugin(f.directory, 'speech-synthesis', {
      revision: configuration(f.directory).revision,
      enabled,
      chats,
      settings,
      permissions: ['audio_read', 'audio_synthesize'],
    });
  const text = { conversationKey: 'wechat:private:filehelper', deliveryId: 'text-tts', text: '测试后台发送。' };
  const send = overrides => f.call('/api/voice/send-text', { body: { ...text, ...overrides } });
  assert.equal((await send()).body.error, 'VOICE_TTS_PLUGIN_DISABLED');
  assert.equal(calls.length, 0);
  set(false);
  const runner = createSettingsActionRunner({
    root: f.directory,
    describe: () => ({ ui: { settings: { actions: ['models', 'check', 'check-input'] } } }),
  });
  t.after(() => runner.close());
  const packageRevision = scanPlugins(f.directory).find(item => item.id === 'speech-synthesis').revision;
  const args = { packageRevision, args: { settings: { apiKey: '' } } };
  assert.deepEqual(
    await runner.run('speech-synthesis', 'models', {
      packageRevision,
      args: { settings: { apiKey: '' }, capability: 'tts' },
    }),
    { ok: true, models: ['team/tts'] },
  );
  const testAudio = await runner.run('speech-synthesis', 'check', args);
  assert.equal(testAudio.ok, true);
  assert.equal(testAudio.durationMs, 9000);
  // Since 1.3.0 the settings preview is 8 kHz 8-bit, at most 5 s, to fit the action result.
  const preview = Buffer.from(testAudio.preview, 'base64');
  assert.deepEqual([preview.readUInt32LE(24), preview.readUInt16LE(34), preview.readUInt32LE(40)], [8000, 8, 40000]);
  assert.equal(testAudio.clipped, true);
  assert.equal(f.backend.submissions.length, 0);
  assert.equal(calls[0].url, '/tenant/v1/models');
  assert.equal(calls[1].body.input, '你好，这是一段语音测试。');

  set(true);
  const submitted = await send();
  assert.equal(submitted.http, 202);
  assert.equal(submitted.body.submitted, true);
  assert.deepEqual(calls[2], {
    url: '/tenant/v1/audio/speech',
    authorization: 'Bearer fixture-key',
    body: { model: 'team/tts', voice: 'fixture-voice', input: text.text, response_format: 'wav' },
  });
  assert.equal(Buffer.from(f.backend.submissions[0].pcmBase64, 'base64').length / 32000, 9);
  await f.restart();
  assert.equal((await send()).body.submitted, true);
  assert.equal((await send({ text: '另一段文字' })).body.error, 'VOICE_DELIVERY_ID_CONFLICT');
  assert.equal(calls.length, 3);
  assert.equal(f.backend.submissions.length, 1);

  providerStatus = 401;
  assert.equal((await send({ deliveryId: 'failed-tts' })).body.error, 'VOICE_TTS_AUTH');
  assert.equal((await send({ deliveryId: 'failed-tts' })).body.status, 'rejected');
  assert.equal(calls.length, 4);
  providerStatus = 200;
  revoke = () => set(false);
  assert.equal((await send({ deliveryId: 'revoked-tts' })).body.error, 'VOICE_TTS_PERMISSION_CHANGED');
  assert.equal(f.backend.submissions.length, 1);
  assert.deepEqual(
    await runner.run('speech-synthesis', 'check-input', {
      packageRevision,
      args: { settings: { apiKey: '' }, method: 'file' },
    }),
    { ok: true, method: 'file', text: '转写测试通过。', partials: [] },
  );
  assert.equal(calls.at(-1).url, '/tenant/v1/audio/transcriptions');
});

test('TTS and single-file recognition keep independent services and keys while the desktop engine gets one logical voice', async t => {
  const f = await fixture(t, {});
  const calls = [];
  const providerWav = pcmWav(Buffer.alloc(16000 * 2, 4));
  const provider = http.createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    calls.push({ url: req.url, authorization: req.headers.authorization });
    if (req.url.startsWith('/asr/')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ text: '单条识别通过。' }));
    }
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.end(providerWav);
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  });
  const origin = 'http://127.0.0.1:' + provider.address().port;
  const source = path.join(import.meta.dirname, '..', 'optional-extensions', 'speech-synthesis');
  const installer = new PluginInstaller(f.directory);
  t.after(() => installer.dispose());
  installer.install(
    installer.inspect({ name: 'speech-synthesis.zip', zip: packZip(packageFiles(source)).toString('base64') }),
  );
  const slot = (entry, method, profile) => ({ entry, method, profiles: { [entry + '/' + method]: profile } });
  // Realtime recognition is configured too, at an address that is never contacted.
  const services = {
    version: 2,
    recognition: 'file',
    reply: 'dsh',
    tts: slot('custom', 'speech', {
      name: 'tts',
      endpoint: origin + '/tts/v1',
      auth: 'bearer',
      model: 'team/tts',
      voice: 'v1',
      speed: 1,
    }),
    realtimeAsr: slot('custom', 'asr', {
      endpoint: 'ws://127.0.0.1:9/never',
      auth: 'none',
      model: 'qwen3-asr-flash-realtime',
    }),
    fileAsr: slot('custom', 'transcriptions', { endpoint: origin + '/asr/v1', auth: 'bearer', model: 'team/asr' }),
    owners: {
      tts: { entry: 'custom', origins: [origin] },
      realtimeAsr: null,
      fileAsr: { entry: 'custom', origins: [origin] },
    },
    legacy: null,
  };
  updatePlugin(f.directory, 'speech-synthesis', {
    revision: configuration(f.directory).revision,
    enabled: true,
    chats: ['wechat:private:filehelper'],
    permissions: ['audio_read', 'audio_synthesize'],
    settings: {
      voiceMode: 'separate',
      recognitionModel: 'team/asr',
      services,
      ttsKey: 'tts-key',
      fileAsrKey: 'asr-key',
    },
  });
  const submitted = await f.call('/api/voice/send-text', {
    body: { conversationKey: 'wechat:private:filehelper', deliveryId: 'v16-tts', text: 'DSH 选择了语音回复。' },
  });
  assert.equal(submitted.http, 202);
  assert.equal(submitted.body.submitted, true);
  assert.deepEqual(calls, [{ url: '/tts/v1/audio/speech', authorization: 'Bearer tts-key' }]);
  assert.equal(f.backend.submissions.length, 1);
  assert.equal(Buffer.from(f.backend.submissions[0].pcmBase64, 'base64').length / 32000, 1);
  const runner = createSettingsActionRunner({
    root: f.directory,
    describe: () => ({ ui: { settings: { actions: ['check-input', 'credentials'] } } }),
  });
  t.after(() => runner.close());
  const packageRevision = scanPlugins(f.directory).find(item => item.id === 'speech-synthesis').revision;
  const draft = { voiceMode: 'separate', recognitionModel: 'team/asr', services, ttsKey: '', fileAsrKey: '' };
  assert.deepEqual(
    await runner.run('speech-synthesis', 'check-input', { packageRevision, args: { settings: draft, method: 'file' } }),
    { ok: true, method: 'file', text: '单条识别通过。', partials: [] },
  );
  assert.deepEqual(calls.at(-1), { url: '/asr/v1/audio/transcriptions', authorization: 'Bearer asr-key' });
  const sources = await runner.run('speech-synthesis', 'credentials', { packageRevision, args: { settings: draft } });
  assert.deepEqual(sources, { ok: true, sources: { tts: 'tts', realtimeAsr: 'none', fileAsr: 'fileAsr' } });
  assert(!JSON.stringify(sources).includes('tts-key'));
});

// ---- Realtime reply choice (voice-dialogue-v1) through the full Helper backend ----

// A Realtime provider on a real WebSocket. `choices` are answered in order to
// the text-only decision responses; audio responses read the last choice.
async function realtimeProvider(t, choices, { audioStatus = () => 'completed', onAudio } = {}) {
  const provider = new ReverseOneBotServer({
    port: 0,
    path: '/tenant/v1/realtime?model=realtime-fixture',
    token: 'fixture-key',
  });
  await provider.start();
  t.after(() => provider.stop());
  const events = [];
  let last;
  function sendEvent(event) {
    const body = Buffer.from(JSON.stringify(event));
    const header =
      body.length < 126
        ? Buffer.from([129, body.length])
        : body.length < 65536
          ? Buffer.from([129, 126, body.length >> 8, body.length & 255])
          : Buffer.concat([
              Buffer.from([129, 127, 0, 0, 0, 0]),
              Buffer.from([body.length >>> 24, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255]),
            ]);
    provider.socket.write(Buffer.concat([header, body]));
  }
  provider.on('event', event => {
    events.push(event);
    if (event.type === 'session.update') sendEvent({ type: 'session.updated' });
    if (event.type === 'input_audio_buffer.commit') sendEvent({ type: 'input_audio_buffer.committed' });
    if (event.type !== 'response.create') return;
    const id = 'r' + events.length;
    sendEvent({ type: 'response.created', response: { id } });
    if (event.response?.output_modalities?.[0] === 'text') {
      const next = choices.shift();
      last = next;
      const raw = typeof next === 'string' ? next : JSON.stringify(next);
      sendEvent({ type: 'response.output_text.delta', response_id: id, delta: raw });
      sendEvent({ type: 'response.output_text.done', response_id: id, text: raw });
      sendEvent({ type: 'response.done', response: { id, status: 'completed' } });
      return;
    }
    onAudio?.();
    // Segmented audio: two chunks of 50 ms at 24 kHz.
    for (let index = 0; index < 2; index++)
      sendEvent({ type: 'response.output_audio.delta', response_id: id, delta: Buffer.alloc(2400).toString('base64') });
    sendEvent({ type: 'response.output_audio_transcript.done', response_id: id, transcript: last?.text ?? '' });
    sendEvent({ type: 'response.done', response: { id, status: audioStatus() } });
  });
  return { provider, events };
}

async function realtimeFixture(t, choices, providerOptions) {
  const f = await fixture(t, { stream: true, receiptTimeoutMs: 1500 });
  f.backend.autoConfirm = true;
  const { provider, events } = await realtimeProvider(t, choices, providerOptions);
  const installer = new PluginInstaller(f.directory);
  t.after(() => installer.dispose());
  const source = path.join(import.meta.dirname, '..', 'optional-extensions', 'speech-synthesis');
  installer.install(
    installer.inspect({ name: 'speech-dialogue.zip', zip: packZip(packageFiles(source)).toString('base64') }),
  );
  updatePlugin(f.directory, 'speech-synthesis', {
    revision: configuration(f.directory).revision,
    enabled: true,
    chats: ['wechat:private:wxid_other'],
    permissions: ['audio_read', 'audio_synthesize'],
    settings: {
      voiceMode: 'realtime',
      realtimeEndpoint: 'ws://127.0.0.1:' + provider.server.address().port + '/tenant/v1/realtime',
      apiKey: 'fixture-key',
      realtimeModel: 'realtime-fixture',
      voice: 'fixture-voice',
    },
  });
  // The desktop engine supplies per-segment acoustic receipts.
  f.backend.targetRows.set('wxid_other', []);
  const textEvent = (rawid, content) => ({
    event: 'message.new',
    type: 1,
    rawid,
    sessionId: 'wxid_other',
    talkerId: 'wxid_other',
    conversationId: 'wxid_other',
    content,
  });
  const voiceEvent = id => ({
    event: 'message.new',
    type: 34,
    rawid: 'v' + id.slice(0, 6),
    sessionId: 'wxid_other',
    talkerId: 'wxid_other',
    conversationId: 'wxid_other',
    content: '[语音]',
    voice: { id, durationSeconds: 0.1 },
  });
  const settle = async () => {
    await until(() => f.backend.inbox.length === 0, 'durable Reader acknowledgements');
    await f.adapter().realtimeQueue;
  };
  const records = () =>
    fs
      .readdirSync(path.join(f.directory, 'state/realtime-replies'))
      .filter(name => name.endsWith('.json'))
      .map(name => JSON.parse(fs.readFileSync(path.join(f.directory, 'state/realtime-replies', name), 'utf8')));
  return { ...f, events, textEvent, voiceEvent, settle, records };
}

async function until(check, label = 'condition') {
  const deadline = Date.now() + 8000;
  while (!check()) {
    assert(Date.now() < deadline, label + ' timed out');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

test('Realtime chooses per turn: text in -> one voice, voice in -> one text, duplicates and restarts send nothing more', async t => {
  const f = await realtimeFixture(t, [
    { mode: 'voice', text: '好，我给你念一遍。' },
    { mode: 'text', text: '这是你要复制的命令：ls -la' },
  ]);
  const asked = f.textEvent('1001', '用语音回答：你好吗？');
  f.backend.emitVoice(asked);
  await until(() => f.backend.submissions.length === 1, 'voice submit');
  await f.settle();
  assert.equal(f.backend.textSubmissions.length, 0);
  const decide = f.events.find(event => event.type === 'session.update').session;
  assert.deepEqual(decide.output_modalities, ['text']);
  assert.match(decide.instructions, /本轮可以回复文字（text）或语音（voice）/);
  assert.equal(
    f.events.find(event => event.type === 'conversation.item.create').item.content[0].text,
    '用语音回答：你好吗？',
  );
  assert.equal(f.backend.submissions[0].target, 'wxid_other');

  const spoken = f.voiceEvent('d'.repeat(64));
  f.backend.emitVoice(spoken);
  await until(() => f.backend.textSubmissions.length === 1, 'text submit');
  await f.settle();
  assert.equal(f.backend.textSubmissions[0].text, '这是你要复制的命令：ls -la');
  assert.equal(f.backend.submissions.length, 1);
  await until(() => f.records().every(record => record.stage === 'sent'), 'records sent');
  assert.deepEqual(
    f
      .records()
      .map(record => [record.input, record.mode])
      .sort(),
    [
      ['text', 'voice'],
      ['voice', 'text'],
    ],
  );
  assert.equal(f.records().find(record => record.mode === 'text').textStatus, 'confirmed');

  // Duplicate events, then a restart with the same events: nothing is sent again.
  f.backend.emitVoice(asked);
  f.backend.emitVoice(spoken);
  await f.settle();
  await f.restart();
  f.backend.emitVoice(asked);
  f.backend.emitVoice(spoken);
  await f.settle();
  assert.deepEqual([f.backend.submissions.length, f.backend.textSubmissions.length], [1, 1]);
  assert.equal(f.events.filter(event => event.type === 'session.update').length, 2);
});

test('an invalid choice ends the turn; a definite synthesis failure sends the chosen text once', async t => {
  let audioStatus = 'incomplete';
  const f = await realtimeFixture(t, ['我就直接说吧', { mode: 'voice', text: '语音没生成，改回文字。' }], {
    audioStatus: () => audioStatus,
  });
  f.backend.emitVoice(f.textEvent('2001', '你好'));
  await until(() => f.adapter().status.last_error === 'VOICE_REALTIME_CHOICE_INVALID', 'invalid choice');
  await f.settle();
  assert.deepEqual([f.backend.submissions.length, f.backend.textSubmissions.length], [0, 0]);

  const second = f.textEvent('2002', '再说一次');
  f.backend.emitVoice(second);
  await until(() => f.backend.textSubmissions.length === 1, 'fallback text');
  await f.settle();
  assert.equal(f.backend.textSubmissions[0].text, '语音没生成，改回文字。');
  assert.equal(f.backend.submissions.length, 0);
  const record = f.records().find(item => item.fallback === 'text');
  assert.deepEqual([record.mode, record.voiceError, record.stage], ['voice', 'VOICE_REALTIME_AUDIO', 'sent']);
  audioStatus = 'completed';
  f.backend.emitVoice(second);
  await f.settle();
  assert.equal(f.backend.textSubmissions.length, 1);
});

test('permission revoked before sending stops both forms; an uncertain voice submit is only checked by receipt', async t => {
  let revoke;
  const f = await realtimeFixture(
    t,
    [
      { mode: 'voice', text: '撤销前的语音' },
      { mode: 'voice', text: '提交结果未知的语音' },
    ],
    { onAudio: () => revoke?.() },
  );
  revoke = () => {
    f.config.wechat.whitelist.private = [target];
    f.saveConfig();
  };
  f.backend.emitVoice(f.textEvent('3001', '你好'));
  await until(() => f.events.filter(event => event.type === 'response.create').length === 2, 'audio requested');
  await f.settle();
  assert.deepEqual([f.backend.submissions.length, f.backend.textSubmissions.length], [0, 0]);

  revoke = undefined;
  f.config.wechat.whitelist.private = [target, 'wxid_other'];
  f.saveConfig();
  f.backend.loseVoice = true;

  const uncertain = f.textEvent('3002', '用语音说');
  f.backend.emitVoice(uncertain);
  await until(() => f.backend.submissions.length === 1, 'uncertain voice submit');
  await f.settle();
  assert.equal(f.backend.textSubmissions.length, 0, 'an uncertain voice submit is never replaced by text');
  const record = f.records().find(item => item.text === '提交结果未知的语音');
  await f.restart();
  f.backend.loseVoice = false;
  f.backend.emitVoice(uncertain);
  await f.settle();
  assert.deepEqual([f.backend.submissions.length, f.backend.textSubmissions.length], [1, 0]);
  // A late receipt confirms the original delivery without sending again.
  f.backend.confirmLatest('920000000000000002');
  const status = await f.status(record.id);
  assert.equal(status.body.status, 'confirmed');
  assert.equal(status.body.receiptSource, 'desktop-acoustic-match');
  assert.equal(f.backend.submissions.length, 1);
});

test('a backend without voice offers the model text only and sends the reply as text', async t => {
  const f = await realtimeFixture(t, [{ mode: 'voice', text: '本轮只能打字回复。' }]);
  f.backend.voiceEnabled = false;
  f.backend.emitVoice(f.textEvent('4001', '你好'));
  await until(() => f.backend.textSubmissions.length === 1, 'text-only reply');
  await f.settle();
  assert.match(f.events.find(event => event.type === 'session.update').session.instructions, /本轮只能回复文字/);
  assert.equal(f.backend.submissions.length, 0);
  assert.equal(f.events.filter(event => event.type === 'response.create').length, 1);
});

test('Realtime sends copyable content as the original text even when a provider selected voice', async t => {
  const f = await realtimeFixture(t, [{ mode: 'voice', text: 'www.example.test' }]);
  f.backend.emitVoice(f.textEvent('5001', '地址发我'));
  await until(() => f.backend.textSubmissions.length === 1, 'copyable reply');
  await f.settle();
  assert.equal(f.backend.textSubmissions[0].text, 'www.example.test');
  assert.equal(f.backend.submissions.length, 0);
});

test('a Realtime text survives an interrupted admission and a Reader acknowledgement lost at reconnect', async t => {
  const f = await realtimeFixture(t, [{ mode: 'text', text: '一次回复' }]);
  f.backend.reconnectBeforeAck = true;
  f.backend.interruptTextAdmission = true;
  const adapter = f.adapter();
  const send = adapter.socket.send.bind(adapter.socket);
  let dshCalls = 0;
  adapter.socket.send = raw => {
    if (JSON.parse(raw).post_type === 'message') dshCalls++;
    return send(raw);
  };
  f.backend.emitVoice(f.textEvent('replayed', '你好'));
  await f.settle();
  assert.equal(dshCalls, 0);
  assert.equal(f.backend.textSubmissions.length, 1);
  assert.equal(f.records()[0].textStatus, 'confirmed');
});
