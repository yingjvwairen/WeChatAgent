import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pcmWav, voicePcm } from './decode-wechat-voice.mjs';
import { WechatOneBot } from './wechat-onebot.mjs';
import { dialogueFeature } from './voice-synthesis.mjs';
import { pcmWave } from './desktop-sender/engine-voice.mjs';
import { PluginInstaller } from '../packages/plugin-api/installer.mjs';
import { PluginRuntime } from '../packages/plugin-api/index.mjs';
import { configuration, packageFiles, scanPlugins, updatePlugin } from '../packages/plugin-api/catalog.mjs';
import { packZip } from '../packages/plugin-api/zip.mjs';
import { createSettingsActionRunner } from './plugin-settings-actions.mjs';
import { ReverseOneBotServer } from '../components/qq-bridge/src/onebot/reverse-ws-server.js';
import { WechatOneBotAdapter } from '../components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js';
import { acceptanceVoiceSource, acceptVoiceDelivery } from './filehelper-acceptance.mjs';
import { selectPluginAccount } from './test-fixtures/plugin-account.mjs';
import { ReplyDeliveryControls } from '../packages/dsh-social-bridge-plugin/reply-delivery-controls.mjs';

const token = 'b'.repeat(64),
  account = 'wxid_fixture_1234',
  chat = 'fixture@chatroom',
  target = 'filehelper';
const wav = pcmWav(Buffer.alloc(3200)),
  route = '/api/voice/send';
function mockReplySynthesis(voice, run = () => {}) {
  voice.synthesis.generate = async ({ beforeInvoke }) => {
    beforeInvoke();
    await run();
    return { wav, allowed: () => true };
  };
}
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
  const pausedTexts = new Map();
  function confirmText(payload) {
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
      operation: 'text',
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
  backend.pausedTexts = pausedTexts;
  backend.resumeText = () => {
    backend.paused = false;
    for (const payload of pausedTexts.values()) confirmText(payload);
    pausedTexts.clear();
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
      if (operation === 'text') {
        if (backend.interruptTextAdmission) {
          backend.interruptTextAdmission = false;
          throw Error('fixture interruption before desktop admission');
        }
        if (!backend.paused) return confirmText(payload);
        pausedTexts.set(payload.deliveryId, payload);
        const result = {
          deliveryId: payload.deliveryId,
          operation,
          admitted: true,
          state: 'paused',
          confirmed: false,
          pending: true,
          submission: 'not-started',
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
        operation,
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

for (const expiresDuringReadiness of [true, false]) {
  test(
    'a staged voice cannot enter the desktop queue after its deadline, during readiness=' + expiresDuringReadiness,
    async t => {
      const f = await fixture(t);
      const adapter = f.adapter();
      const voice = adapter.voiceSend;
      const stalled = t.mock.method(adapter, 'dispatchDesktop', async () => {
        throw Object.assign(Error('temporary desktop admission failure'), { code: 'DESKTOP_CONFIGURATION_BUSY' });
      });
      assert.equal((await f.submit()).body.status, 'pending');
      stalled.mock.restore();
      const staged = voice.load('fixture-id');
      assert(staged.pendingPcm);
      let clock = staged.deadline - 1,
        readinessChecks = 0;
      const time = t.mock.method(Date, 'now', () => clock);
      const identity = voice.identity.bind(voice);
      t.mock.method(voice, 'identity', async (...args) => {
        const scope = await identity(...args);
        if (++readinessChecks === 2 && expiresDuringReadiness) clock = staged.deadline;
        return scope;
      });
      const dispatch = t.mock.method(adapter, 'dispatchDesktop', async (operation, payload, _account, options) => {
        assert.equal(operation, 'voice');
        assert.equal(payload.deliveryId, staged.operationId);
        assert.equal(options.admissionDeadlineAt, staged.deadline);
        clock = staged.deadline;
        throw Object.assign(Error('desktop admission expired'), {
          code: 'DESKTOP_ADMISSION_EXPIRED',
          attempted: false,
        });
      });
      try {
        const response = await f.status();
        assert.equal(readinessChecks, 2);
        assert.equal(dispatch.mock.callCount(), expiresDuringReadiness ? 0 : 1);
        assert.equal(f.backend.submissions.length, 0);
        assert.equal(response.body.status, 'rejected');
        assert.equal(response.body.error, 'VOICE_NOT_ADMITTED');
        assert.equal(voice.load('fixture-id').pendingPcm, undefined);
      } finally {
        time.mock.restore();
      }
    },
  );
}

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
  assert.equal((await bridge.sendVoiceText({ ...request, rosterGrant: grant })).status, 'pending');
  adapter.voiceSend.tickReplies();
  await until(() => adapter.voiceSend.load('dsh-' + request.deliveryId).synthesisState === 'failed');
  const revoked = await bridge.sendVoiceText({ ...request, rosterGrant: grant, receiptOnly: true });
  assert.deepEqual(revoked, { status: 'rejected', fallback: false, error: 'VOICE_CONVERSATION_GRANT_CHANGED' });
  assert.equal(syntheses, 0);
  assert.equal(f.backend.submissions.length, 0);

  adapter.targetsSending.add('private:wxid_other');
  assert.deepEqual(await bridge.sendVoiceText({ ...request, rosterGrant: 'new-grant' }), {
    status: 'rejected',
    fallback: false,
    error: 'VOICE_CONVERSATION_GRANT_CHANGED',
  });
  const nextRequest = { ...request, deliveryId: 'b'.repeat(64), rosterGrant: 'new-grant' };
  const pending = await bridge.sendVoiceText(nextRequest);
  assert.deepEqual(pending, { status: 'pending', fallback: false });
  adapter.voiceSend.tickReplies();
  await until(() => f.backend.submissions.length === 1);
  assert.equal(syntheses, 1);
  assert.equal(f.backend.submissions.length, 1);
  assert.equal(f.backend.submissions[0].rosterGrant, 'new-grant');
  await until(() => adapter.voiceSend.load('dsh-' + nextRequest.deliveryId).nativeStatus === 'pending');
  assert.equal((await bridge.sendVoiceText({ ...nextRequest, receiptOnly: true })).admitted, true);
  f.config.wechat.whitelist.private = [];
  delete f.config.wechat.rosterGrants[key];
  f.saveConfig();
  f.backend.confirmLatest();
  await until(() => {
    adapter.voiceSend.tickReplies();
    return adapter.voiceSend.load('dsh-' + nextRequest.deliveryId).confirmed;
  });
  const confirmed = await bridge.sendVoiceText({ ...nextRequest, receiptOnly: true });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(adapter.voiceSend.replies.has('dsh-' + nextRequest.deliveryId), false);
  assert.equal(f.backend.submissions.length, 1);
});

test('slow voice synthesis leaves OneBot slots free after durable registration', async t => {
  const f = await fixture(t);
  const adapter = f.adapter();
  const voice = adapter.voiceSend;
  const tick = voice.tickReplies.bind(voice);
  voice.tickReplies = () => {};
  const synthesis = Promise.withResolvers();
  let started = 0;
  const selected = { id: 'fixture', generation: '1' };
  voice.synthesis.candidates = () => [selected];
  mockReplySynthesis(voice, async () => {
    started++;
    await synthesis.promise;
  });
  const requests = Array.from({ length: 8 }, (_, index) => ({
    kind: 'private',
    target,
    text: '夹具',
    wechatagent_delivery_id: String(index + 1).repeat(64),
  }));
  const received = [];
  const attempts = requests.map(params =>
    adapter.action({ action: 'send_voice_text', params }).then(reply => received.push(reply)),
  );
  try {
    await until(() => received.length === 8, 'voice admissions');
    assert(received.every(reply => reply.status === 'ok' && reply.data.status === 'pending'));
    for (const request of requests)
      assert.equal(voice.load('dsh-' + request.wechatagent_delivery_id).synthesisState, 'queued');
    assert.equal(started, 0);
    tick();
    await until(() => started === 2);
    const read = await adapter.action({ action: 'get_voice_delivery', params: requests[0] });
    assert.equal(read.data.status, 'pending');
    const text = await adapter.action({
      action: 'send_private_msg',
      params: { user_id: 'wxid_other', message: 'fixture', wechatagent_delivery_id: 'f'.repeat(64) },
    });
    assert.equal(text.status, 'ok', text.message);
    assert.equal(adapter.activeActions, 0);
    assert.equal(f.backend.submissions.length, 0);
    new ReplyDeliveryControls(f.directory, adapter.accountRef).withdrawInputs('wechat:private:' + target, 'legacy', [
      requests[0].wechatagent_delivery_id,
    ]);
  } finally {
    synthesis.resolve();
    await Promise.all(attempts);
    await until(() => voice.replySynthesis.size === 0);
  }
  assert.equal(f.backend.submissions.length, 1);
  assert.equal(f.backend.submissions[0].parentId, requests[1].wechatagent_delivery_id);
  assert.equal((await adapter.action({ action: 'get_voice_delivery', params: requests[0] })).data.fallback, false);
});

test('slow voice receipt checks leave workers available for newly queued synthesis', async t => {
  const f = await fixture(t);
  const adapter = f.adapter();
  const voice = adapter.voiceSend;
  const tick = voice.tickReplies.bind(voice);
  voice.tickReplies = () => {};
  const selected = { id: 'fixture', generation: '1' };
  voice.synthesis.candidates = () => [selected];
  mockReplySynthesis(voice);
  const enqueue = letter =>
    voice.speakReply({ kind: 'private', target, text: 'fixture', deliveryId: letter.repeat(64) });
  for (const letter of ['a', 'b']) assert.equal(enqueue(letter).status, 'pending');
  tick();
  await until(() => f.backend.submissions.length === 2 && voice.replySynthesis.size === 0);

  const receipts = Promise.withResolvers();
  const operations = new Set(f.backend.submissions.map(item => item.deliveryId));
  const request = adapter.desktopSender.request.bind(adapter.desktopSender);
  let checks = 0;
  adapter.desktopSender.request = async (operation, payload, options) => {
    if (operation === 'lookup' && operations.has(payload.deliveryId)) {
      checks++;
      await receipts.promise;
    }
    return request(operation, payload, options);
  };
  try {
    tick();
    await until(() => checks === 2);
    assert.equal(enqueue('c').status, 'pending');
    tick();
    await until(() => f.backend.submissions.length === 3);
    assert.equal(voice.replyReceiptChecks.size, 2);
  } finally {
    receipts.resolve();
  }
});

test('slow old voice observations preserve both current receipt slots', async t => {
  const f = await fixture(t);
  const adapter = f.adapter();
  const voice = adapter.voiceSend;
  const tick = voice.tickReplies.bind(voice);
  voice.tickReplies = () => {};
  const ready = observeOnly => ({ job: { accountRef: adapter.accountRef }, observeOnly, admitted: true });
  const held = Promise.withResolvers();
  const checks = [];
  voice.runReply = async (id, observeOnly) => {
    checks.push([id, observeOnly]);
    await held.promise;
  };
  voice.replies.set('old-1', ready(true));
  voice.replies.set('old-2', ready(true));
  try {
    tick();
    voice.replies.set('current-1', ready(false));
    voice.replies.set('current-2', ready(false));
    tick();
    assert.deepEqual(checks, [
      ['old-1', true],
      ['old-2', true],
      ['current-1', false],
      ['current-2', false],
    ]);
    assert.equal(voice.replyObservationChecks.size, 2);
    assert.equal(voice.replyReceiptChecks.size, 2);
  } finally {
    held.resolve();
    await until(() => voice.active.size === 0);
  }
});

test('staged DSH audio awaiting admission does not take the admitted voice receipt slots', async t => {
  const f = await fixture(t);
  const adapter = f.adapter();
  const voice = adapter.voiceSend;
  const tick = voice.tickReplies.bind(voice);
  voice.tickReplies = () => {};
  voice.synthesis.candidates = () => [{ id: 'fixture', generation: '1' }];
  mockReplySynthesis(voice);
  const dispatch = adapter.dispatchDesktop.bind(adapter);
  const known = 'c'.repeat(64);
  adapter.dispatchDesktop = async (operation, body, ...args) => {
    if (body.parentId !== known) throw Error('lost before admission');
    return dispatch(operation, body, ...args);
  };
  const staged = new Set();
  let admitted;
  for (const letter of ['a', 'b', 'c']) {
    const deliveryId = letter.repeat(64);
    assert.equal(voice.speakReply({ kind: 'private', target, text: 'fixture', deliveryId }).status, 'pending');
    const id = 'dsh-' + deliveryId;
    await voice.runReply(id, false);
    const job = voice.load(id);
    if (deliveryId === known) {
      assert.equal(job.pendingPcm, undefined);
      admitted = job.operationId;
    } else {
      assert.ok(job.pendingPcm);
      staged.add(job.operationId);
    }
  }

  const gate = Promise.withResolvers();
  const request = adapter.desktopSender.request.bind(adapter.desktopSender);
  let held = 0;
  let checked = false;
  adapter.desktopSender.request = async (operation, body, options) => {
    if (operation === 'lookup' && staged.has(body.deliveryId)) {
      held++;
      await gate.promise;
    }
    if (operation === 'lookup' && body.deliveryId === admitted) checked = true;
    return request(operation, body, options);
  };
  try {
    tick();
    await until(() => held === 2);
    assert.equal(checked, true);
  } finally {
    gate.resolve();
    await until(() => voice.active.size === 0);
  }
});

for (const restart of [false, true]) {
  test('read-only checks of staged voices release the synthesis pool, restart=' + restart, async t => {
    const f = await fixture(t);
    let adapter = f.adapter();
    let voice = adapter.voiceSend;
    let tick = voice.tickReplies.bind(voice);
    voice.tickReplies = () => {};
    const selected = { id: 'fixture', generation: '1' };
    voice.synthesis.candidates = () => [selected];
    mockReplySynthesis(voice);
    const dispatch = adapter.dispatchDesktop.bind(adapter);
    let staging = true;
    adapter.dispatchDesktop = (...args) => {
      if (staging) throw Error('fixture lost before native admission');
      return dispatch(...args);
    };
    const requests = ['a1', 'a2'].map(value => ({
      kind: 'private',
      target,
      text: 'fixture',
      deliveryId: value.repeat(32),
      expectedRosterGrant: 'legacy',
    }));
    const operations = new Set();
    for (const old of requests) {
      assert.equal(voice.speakReply(old).status, 'pending');
      await voice.runReply('dsh-' + old.deliveryId, false);
      const saved = voice.load('dsh-' + old.deliveryId);
      assert.ok(saved.pendingPcm);
      operations.add(saved.operationId);
      assert.equal(voice.speakReply({ ...old, receiptOnly: true, observeOnly: true }).status, 'pending');
    }
    staging = false;
    if (restart) {
      await f.restart();
      adapter = f.adapter();
      voice = adapter.voiceSend;
      tick = voice.tickReplies.bind(voice);
      voice.tickReplies = () => {};
      voice.synthesis.candidates = () => [selected];
      mockReplySynthesis(voice);
    }
    const held = Promise.withResolvers();
    const get = adapter.desktopSender.request.bind(adapter.desktopSender);
    let checks = 0;
    adapter.desktopSender.request = async (operation, payload, options) => {
      if (operation === 'lookup' && operations.has(payload.deliveryId)) {
        assert.equal(payload.observeOnly, true);
        checks++;
        await held.promise;
        return null;
      }
      return get(operation, payload, options);
    };
    try {
      tick();
      await until(() => checks === 2);
      const fresh = { ...requests[0], deliveryId: 'a3'.repeat(32) };
      assert.equal(voice.speakReply(fresh).status, 'pending');
      tick();
      await until(() => f.backend.submissions.length === 1);
      assert.equal(f.backend.submissions[0].parentId, fresh.deliveryId);
      for (const old of requests) {
        const saved = voice.load('dsh-' + old.deliveryId);
        assert.equal(saved.observeOnly, true);
        assert.ok(saved.pendingPcm);
      }
    } finally {
      held.resolve();
      await until(() => voice.active.size === 0);
    }
    for (const old of requests) {
      const saved = voice.load('dsh-' + old.deliveryId);
      assert.equal(saved.inputError, 'VOICE_NOT_ADMITTED');
      assert.equal(saved.pendingPcm, undefined);
      assert.equal(voice.speakReply({ ...old, receiptOnly: true }).fallback, false);
    }
    assert.equal(f.backend.submissions.length, 1);
  });
}

test('switching a staged voice to observation while lookup is in flight blocks native admission', async t => {
  const f = await fixture(t);
  const adapter = f.adapter();
  const voice = adapter.voiceSend;
  voice.tickReplies = () => {};
  voice.synthesis.candidates = () => [{ id: 'fixture', generation: '1' }];
  mockReplySynthesis(voice);
  const dispatch = t.mock.method(adapter, 'dispatchDesktop', async () => {
    throw Error('fixture response lost');
  });
  const request = { kind: 'private', target, text: 'fixture', deliveryId: 'a4'.repeat(32) };
  const id = 'dsh-' + request.deliveryId;
  voice.speakReply(request);
  await voice.runReply(id, false);
  assert.ok(voice.load(id).pendingPcm);
  dispatch.mock.restore();
  const held = Promise.withResolvers();
  const started = Promise.withResolvers();
  adapter.desktopSender.request = async (operation, scope) => {
    assert.equal(operation, 'lookup');
    assert.equal(scope.observeOnly, true);
    started.resolve();
    return held.promise;
  };
  const checking = voice.runReply(id, false);
  try {
    await started.promise;
    assert.equal(voice.speakReply({ ...request, receiptOnly: true, observeOnly: true }).status, 'pending');
  } finally {
    held.resolve(null);
    await checking;
  }

  assert.equal(f.backend.submissions.length, 0);
  const rejected = voice.load(id);
  assert.equal(rejected.observeOnly, true);
  assert.equal(rejected.inputError, 'VOICE_NOT_ADMITTED');
  assert.equal(voice.speakReply({ ...request, receiptOnly: true }).fallback, false);
});

test('restart resumes queued voice and retires interrupted or withdrawn work under the original ID', async t => {
  const f = await fixture(t);
  const selected = { id: 'fixture', generation: '1' };
  const voice = f.adapter().voiceSend;
  voice.tickReplies = () => {};
  voice.synthesis.candidates = () => [selected];
  const [queued, interrupted, withdrawn] = ['a', 'b', 'c'].map(letter => ({
    kind: 'private',
    target,
    text: '合成夹具',
    deliveryId: letter.repeat(64),
    expectedRosterGrant: 'legacy',
  }));
  for (const request of [queued, interrupted, withdrawn]) assert.equal(voice.speakReply(request).status, 'pending');
  const key = 'wechat:private:' + target;
  const original = voice.load('dsh-' + queued.deliveryId);
  const interruptedJob = voice.load('dsh-' + interrupted.deliveryId);
  voice.save({ ...interruptedJob, synthesisState: 'synthesizing' });
  const otherAccount = {
    ...original,
    deliveryId: 'dsh-' + 'e'.repeat(64),
    operationId: crypto.randomUUID(),
    accountRef: 'e'.repeat(64),
    synthesisState: 'ready',
    sendIntent: true,
    nativeStatus: 'pending',
  };
  voice.save(otherAccount, true);
  new ReplyDeliveryControls(f.directory, original.accountRef).withdrawInputs(key, 'legacy', [withdrawn.deliveryId]);

  await f.restart();
  const recovered = f.adapter().voiceSend;
  assert.equal(recovered.replies.has(otherAccount.deliveryId), false);
  assert.equal(recovered.load(otherAccount.deliveryId).operationId, otherAccount.operationId);
  f.backend.autoConfirm = true;
  recovered.synthesis.candidates = () => [selected];
  let calls = 0;
  mockReplySynthesis(recovered, () => {
    calls++;
  });
  recovered.tickReplies();
  await until(() => recovered.load(original.deliveryId).confirmed === true, 'recovered voice receipt');
  await until(() => recovered.load(interruptedJob.deliveryId).synthesisState === 'failed', 'interrupted synthesis');
  await until(() => recovered.load('dsh-' + withdrawn.deliveryId).synthesisState === 'failed');
  assert.equal(calls, 1);
  assert.equal(f.backend.submissions.length, 1);
  assert.equal(f.backend.submissions[0].deliveryId, original.operationId);
  const interruptedResult = recovered.speakReply({ ...interrupted, receiptOnly: true });
  assert.equal(interruptedResult.error, 'VOICE_TTS_INTERRUPTED');
  assert.equal(interruptedResult.fallback, true);
  assert.equal(recovered.speakReply({ ...withdrawn, receiptOnly: true }).fallback, false);
  assert.equal(recovered.speakReply(queued).receipt, 'wechat-server-id');
});

test('a late voice receipt refreshes the original operation in the background', async t => {
  const f = await fixture(t);
  const voice = f.adapter().voiceSend;
  const tick = voice.tickReplies.bind(voice);
  voice.tickReplies = () => {};
  voice.synthesis.candidates = () => [{ id: 'fixture', generation: '1' }];
  mockReplySynthesis(voice);
  f.backend.nextResult = { state: 'unconfirmed', pending: false, submission: 'unknown' };
  const request = { kind: 'private', target, text: 'fixture', deliveryId: 'd'.repeat(64) };
  assert.equal(voice.speakReply(request).status, 'pending');
  tick();
  await until(() => voice.load('dsh-' + request.deliveryId).nativeStatus === 'unconfirmed');
  const operation = f.backend.submissions[0].deliveryId;
  const adapter = f.adapter();
  const bridge = new WechatOneBotAdapter();
  bridge.server.action = async (action, params) => {
    const result = await adapter.action({ action, params });
    assert.equal(result.status, 'ok', result.message);
    return result;
  };
  const query = () =>
    bridge.inspectReplyReceipt(
      { kind: 'private', conversation_id: target, readerGrant: 'legacy' },
      { voiceText: request.text, deliveryId: request.deliveryId },
    );
  assert.equal((await query()).status, 'pending');
  tick();
  await until(() => voice.replyObservationChecks.size === 0);
  assert.equal((await query()).status, 'unconfirmed');
  assert.equal(voice.replies.has('dsh-' + request.deliveryId), false);

  const desktopRequest = adapter.desktopSender.request.bind(adapter.desktopSender);
  const reader = t.mock.method(adapter.desktopSender, 'request', async (operation, payload, options) => {
    if (operation !== 'lookup') return desktopRequest(operation, payload, options);
    throw Error('Reader temporarily unavailable');
  });
  assert.equal((await query()).status, 'pending');
  tick();
  await until(() => voice.replyObservationChecks.size === 0);
  assert.equal((await query()).status, 'unconfirmed');
  reader.mock.restore();

  f.backend.confirmLatest();
  assert.equal((await query()).status, 'pending');
  tick();
  await until(() => voice.load('dsh-' + request.deliveryId).confirmed);
  assert.equal((await query()).status, 'confirmed');
  assert.equal(voice.replies.has('dsh-' + request.deliveryId), false);
  assert.equal(voice.load('dsh-' + request.deliveryId).operationId, operation);
  assert.equal(f.backend.submissions.length, 1);
});

for (const loseResponse of [false, true]) {
  test(`a saved voice receipt survives disabling its TTS provider, lost admission response=${loseResponse}`, async t => {
    const f = await fixture(t, { loseResponse });
    const adapter = f.adapter();
    const voice = adapter.voiceSend;
    const tick = voice.tickReplies.bind(voice);
    voice.tickReplies = () => {};
    const provider = t.mock.method(voice.synthesis, 'candidates', () => [{ id: 'fixture', generation: '1' }]);
    mockReplySynthesis(voice);
    const deliveryId = 'ac'.repeat(32);
    const params = { kind: 'private', target, text: 'fixture', wechatagent_delivery_id: deliveryId };
    const read = () =>
      adapter.action({ action: 'get_voice_delivery', params: { ...params, wechatagent_observe_only: true } });
    assert.equal((await adapter.action({ action: 'send_voice_text', params })).data.status, 'pending');
    tick();
    await until(() => f.backend.submissions.length === 1 && voice.replySynthesis.size === 0);
    const saved = voice.load('dsh-' + deliveryId);
    assert.equal(!!saved.pendingPcm, loseResponse);

    provider.mock.mockImplementation(() => []);
    const health = t.mock.method(adapter, 'checkNative', async () => assert.fail('receipt lookup must be read-only'));
    f.backend.confirmLatest();
    assert.equal((await read()).data.status, 'pending');
    tick();
    await until(() => voice.replyObservationChecks.size === 0);
    const observed = await read();
    assert.equal(observed.status, 'ok', observed.message);
    assert.equal(observed.data.status, 'confirmed');
    assert.equal(health.mock.callCount(), 0);
    assert.equal(voice.load(saved.deliveryId).operationId, saved.operationId);
    assert.equal(voice.load(saved.deliveryId).pendingPcm, undefined);
    assert.equal(f.backend.submissions.length, 1);
  });
}

for (const admittedBeforeRestart of [false, true]) {
  test('DSH retries the saved voice scope after a lost response, admitted=' + admittedBeforeRestart, async t => {
    const f = await fixture(t, { loseResponse: admittedBeforeRestart });
    const adapter = f.adapter();
    const voice = adapter.voiceSend;
    const tick = voice.tickReplies.bind(voice);
    voice.tickReplies = () => {};
    const selected = { id: 'fixture', generation: '1' };
    voice.synthesis.candidates = () => [selected];
    mockReplySynthesis(voice);
    if (!admittedBeforeRestart)
      adapter.dispatchDesktop = async () => {
        throw Error('Interrupted before desktop admission');
      };
    const request = { kind: 'private', target, text: 'fixture', deliveryId: 'f'.repeat(64) };
    const id = 'dsh-' + request.deliveryId;
    assert.equal(voice.speakReply(request).status, 'pending');
    tick();
    await until(() => voice.load(id).pendingPcm && voice.replySynthesis.size === 0);
    const original = voice.load(id);
    assert.equal(f.backend.submissions.length, Number(admittedBeforeRestart));

    f.backend.loseVoice = false;
    await f.restart();
    const recovered = f.adapter().voiceSend;
    recovered.synthesis.candidates = () => [selected];
    recovered.synthesis.generate = () => assert.fail('prepared audio must be reused after restart');
    recovered.tickReplies();
    await until(() => f.backend.submissions.length === 1 && !recovered.load(id).pendingPcm);
    assert.equal(f.backend.submissions[0].deliveryId, original.operationId);
    assert.equal(f.backend.submissions[0].pcmBase64, original.pendingPcm);

    f.backend.confirmLatest();
    const query = { ...request, receiptOnly: true, observeOnly: true };
    recovered.speakReply(query);
    recovered.tickReplies();
    await until(() => recovered.load(id).confirmed);
    assert.equal(recovered.speakReply(query).status, 'confirmed');
    assert.equal(f.backend.submissions.length, 1);
  });
}

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

for (const [preparedAudio, withdrawAfterFault] of [
  [false, false],
  [true, false],
  [true, true],
]) {
  test(`a temporary permission lookup failure preserves the voice intent, prepared=${preparedAudio} withdrawn=${withdrawAfterFault}`, async t => {
    const f = await fixture(t);
    const adapter = f.adapter();
    const voice = adapter.voiceSend;
    const tick = voice.tickReplies.bind(voice);
    voice.tickReplies = () => {};
    const selected = { id: 'fixture', generation: '1' };
    let syntheses = 0;
    voice.synthesis.candidates = () => [selected];
    mockReplySynthesis(voice, () => {
      syntheses++;
    });
    const request = { kind: 'private', target, text: 'fixture', deliveryId: 'a'.repeat(64) };
    const id = 'dsh-' + request.deliveryId;
    assert.equal(voice.speakReply(request).status, 'pending');
    if (preparedAudio) {
      const dispatch = t.mock.method(adapter, 'dispatchDesktop', async () => {
        throw Error('interrupted before desktop admission');
      });
      tick();
      await until(() => voice.load(id).pendingPcm && voice.replySynthesis.size === 0);
      dispatch.mock.restore();
    }
    const original = voice.load(id);
    const accountLookup = t.mock.method(adapter, 'receiptAccount', () => {
      throw Object.assign(Error('Temporary account read failure'), { code: 'EBUSY' });
    });
    const observation = await adapter.action({
      action: 'get_voice_delivery',
      params: { kind: request.kind, target, text: request.text, wechatagent_delivery_id: request.deliveryId },
    });
    assert.equal(observation.status, 'failed');
    accountLookup.mock.restore();

    const blocked = t.mock.method(ReplyDeliveryControls.prototype, 'inputWithdrawn', () => {
      throw Object.assign(Error('Temporary permission store lock'), { code: 'SQLITE_BUSY' });
    });
    tick();
    await until(() => voice.replySynthesis.size === 0 && voice.replyReceiptChecks.size === 0);
    blocked.mock.restore();
    const saved = voice.load(id);
    assert.equal(saved.pendingPcm === original.pendingPcm, true);
    assert.deepEqual(
      { ...saved, pendingPcm: undefined, queryError: undefined },
      { ...original, pendingPcm: undefined, queryError: undefined },
    );
    assert.equal(f.backend.submissions.length, 0);
    assert.equal(syntheses, Number(preparedAudio));

    if (withdrawAfterFault) {
      new ReplyDeliveryControls(f.directory, adapter.accountRef).withdrawInputs('wechat:private:' + target, 'legacy', [
        request.deliveryId,
      ]);
      tick();
      await until(() => voice.load(id).rejected === true);
      assert.equal(f.backend.submissions.length, 0);
      assert.equal(voice.speakReply({ ...request, receiptOnly: true }).fallback, false);
      return;
    }
    tick();
    await until(() => f.backend.submissions.length === 1);
    assert.equal(f.backend.submissions[0].deliveryId, original.operationId);
    if (preparedAudio) assert.equal(f.backend.submissions[0].pcmBase64, original.pendingPcm);
    assert.equal(syntheses, 1);
  });
}

for (const [audioGenerated, withdraw] of [
  [false, false],
  [true, false],
  [true, true],
]) {
  test(`a permission read failure during DSH synthesis is retryable, generated=${audioGenerated}, withdrawn=${withdraw}`, async t => {
    const f = await fixture(t);
    const adapter = f.adapter();
    const voice = adapter.voiceSend;
    const tick = voice.tickReplies.bind(voice);
    voice.tickReplies = () => {};
    let busy = false,
      injected = false,
      syntheses = 0;
    function lockOnce() {
      if (!injected) {
        busy = true;
        injected = true;
      }
    }
    const provider = http.createServer(async (req, res) => {
      for await (const chunk of req) void chunk;
      syntheses++;
      if (audioGenerated) lockOnce();
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(wav);
    });
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      provider.closeAllConnections();
      await new Promise(resolve => provider.close(resolve));
    });
    const source = path.join(import.meta.dirname, '..', 'optional-extensions', 'speech-synthesis');
    const installer = new PluginInstaller(f.directory);
    t.after(() => installer.dispose());
    installer.install(
      installer.inspect({ name: 'speech-synthesis.zip', zip: packZip(packageFiles(source)).toString('base64') }),
    );
    const key = 'wechat:private:' + target;
    updatePlugin(f.directory, 'speech-synthesis', {
      revision: configuration(f.directory).revision,
      enabled: true,
      chats: [key],
      settings: {
        endpoint: 'http://127.0.0.1:' + provider.address().port + '/v1/audio/speech',
        apiKey: 'fixture-key',
        model: 'fixture-tts',
        voice: 'fixture',
      },
      permissions: ['audio_read', 'audio_synthesize'],
    });
    const inputWithdrawn = ReplyDeliveryControls.prototype.inputWithdrawn;
    t.mock.method(ReplyDeliveryControls.prototype, 'inputWithdrawn', function (...args) {
      if (busy) throw Object.assign(Error('temporary permission store lock'), { code: 'SQLITE_BUSY' });
      return inputWithdrawn.apply(this, args);
    });
    if (!audioGenerated) {
      const sync = PluginRuntime.prototype.sync;
      t.mock.method(PluginRuntime.prototype, 'sync', async function (...args) {
        const result = await sync.apply(this, args);
        lockOnce();
        return result;
      });
    }
    const request = { kind: 'private', target, text: 'fixture DSH voice', deliveryId: 'b8'.repeat(32) };
    const id = 'dsh-' + request.deliveryId;
    assert.equal(voice.speakReply(request).status, 'pending');
    const operationId = voice.load(id).operationId;
    tick();
    await until(() => injected && voice.replySynthesis.size === 0);
    const saved = voice.load(id);
    assert.equal(saved.synthesisState, audioGenerated ? 'ready' : 'queued');
    assert.equal(syntheses, Number(audioGenerated));
    assert.equal(!!saved.pendingPcm, audioGenerated);
    assert.equal(f.backend.submissions.length, 0);

    busy = false;
    if (withdraw)
      new ReplyDeliveryControls(f.directory, adapter.accountRef).withdrawInputs(key, 'legacy', [request.deliveryId]);
    tick();
    await until(() => voice.active.size === 0);
    assert.equal(syntheses, 1);
    assert.equal(voice.load(id).operationId, operationId);
    assert.equal(f.backend.submissions.length, withdraw ? 0 : 1);
    if (withdraw) {
      assert.equal(voice.load(id).pendingPcm, undefined);
      assert.equal(voice.speakReply({ ...request, receiptOnly: true }).fallback, false);
    } else {
      assert.equal(f.backend.submissions[0].deliveryId, operationId);
      if (audioGenerated) assert.equal(f.backend.submissions[0].pcmBase64, saved.pendingPcm);
    }
  });
}

for (const scenario of ['reader offline', 'adapter stopped', 'grant replaced']) {
  test('completed DSH audio stays bound to its original scope before admission, ' + scenario, async t => {
    const f = await fixture(t);
    const adapter = f.adapter();
    const voice = adapter.voiceSend;
    const tick = voice.tickReplies.bind(voice);
    voice.tickReplies = () => {};
    const selected = { id: 'fixture', generation: '1' };
    voice.synthesis.candidates = () => [selected];
    let generated = 0,
      checking = false;
    mockReplySynthesis(voice, () => {
      generated++;
    });
    const released = Promise.withResolvers();
    const read = adapter.reader.bind(adapter);
    t.mock.method(adapter, 'reader', async (route, ...args) => {
      if (generated && route === '/api/v1/reader/status') {
        checking = true;
        if (scenario === 'reader offline') throw Error('READER_HTTP_TIMEOUT');
        await released.promise;
      }
      return read(route, ...args);
    });
    const request = { kind: 'private', target, text: 'fixture speech', deliveryId: 'dd'.repeat(32) };
    const id = 'dsh-' + request.deliveryId;
    assert.equal(voice.speakReply(request).status, 'pending');
    const operationId = voice.load(id).operationId;
    tick();
    try {
      await until(() => checking);
      if (scenario === 'adapter stopped') {
        const stopping = adapter.stop();
        released.resolve();
        await stopping;
      }
      if (scenario === 'grant replaced') {
        f.config.wechat.rosterGrants = { ['wechat:private:' + target]: 'replacement-grant' };
        f.saveConfig();
        released.resolve();
      }
      await until(() => voice.active.size === 0);
      const saved = voice.load(id);
      assert.equal(saved.synthesisState, 'ready');
      assert.equal(saved.operationId, operationId);
      assert.equal(f.backend.submissions.length, 0);
      if (scenario === 'grant replaced') {
        assert.equal(saved.pendingPcm, undefined);
        assert.equal(voice.speakReply({ ...request, receiptOnly: true }).fallback, false);
        assert.equal(saved.inputError, 'VOICE_CONVERSATION_GRANT_CHANGED');
        return;
      }
      assert(saved.pendingPcm);

      await f.restart();
      const recovered = f.adapter().voiceSend;
      recovered.synthesis.candidates = () => [selected];
      recovered.synthesis.generate = () => assert.fail('restart must reuse the saved audio');
      recovered.tickReplies();
      await until(() => f.backend.submissions.length === 1 && !recovered.load(id).pendingPcm);
      assert.equal(f.backend.submissions[0].deliveryId, operationId);
      assert.equal(f.backend.submissions[0].pcmBase64, saved.pendingPcm);
      assert.equal(generated, 1);
    } finally {
      released.resolve();
    }
  });
}

test('local text-to-speech keeps completed audio when Reader goes offline before desktop admission', async t => {
  const f = await fixture(t);
  const adapter = f.adapter();
  const voice = adapter.voiceSend;
  const selected = { id: 'fixture', generation: '1' };
  voice.synthesis.candidates = () => [selected];
  let generated = 0;
  voice.synthesis.generate = async () => {
    generated++;
    return { wav, allowed: () => true };
  };
  const read = adapter.reader.bind(adapter);
  t.mock.method(adapter, 'reader', async (route, ...args) => {
    if (generated && route === '/api/v1/reader/status') throw Error('READER_HTTP_TIMEOUT');
    return read(route, ...args);
  });
  const body = { conversationKey: 'wechat:private:filehelper', deliveryId: 'local-recovery', text: 'fixture voice' };
  assert.equal((await f.call('/api/voice/send-text', { body })).http, 202);
  const saved = voice.load(body.deliveryId);
  assert(saved.pendingPcm);
  assert.equal(f.backend.submissions.length, 0);

  await f.restart();
  const recovered = f.adapter().voiceSend;
  recovered.synthesis.candidates = () => [selected];
  recovered.synthesis.generate = () => assert.fail('a retry must reuse the saved audio');
  assert.equal((await f.call('/api/voice/send-text', { body })).http, 202);
  assert.equal(f.backend.submissions.length, 1);
  assert.equal(f.backend.submissions[0].deliveryId, saved.operationId);
  assert.equal(f.backend.submissions[0].pcmBase64, saved.pendingPcm);
  assert.equal(generated, 1);
});

for (const queuedReply of [false, true]) {
  test('voice admission waits for desktop queue capacity, DSH=' + queuedReply, async t => {
    const f = await fixture(t);
    const adapter = f.adapter();
    const voice = adapter.voiceSend;
    const tick = voice.tickReplies.bind(voice);
    voice.tickReplies = () => {};
    let full = true,
      syntheses = 0;
    const dispatch = adapter.dispatchDesktop.bind(adapter);
    t.mock.method(adapter, 'dispatchDesktop', async (operation, ...args) => {
      if (operation === 'voice' && full)
        throw Object.assign(Error('desktop queue is full'), {
          code: queuedReply ? 'API_HTTP_409' : 'DESKTOP_STORAGE_LIMIT',
          ...(queuedReply ? { senderCode: 'DESKTOP_STORAGE_LIMIT' } : {}),
          attempted: false,
        });
      return dispatch(operation, ...args);
    });
    const request = { kind: 'private', target, text: 'fixture voice', deliveryId: '7c'.repeat(32) };
    const id = queuedReply ? 'dsh-' + request.deliveryId : 'native-capacity-fixture';
    async function poll() {
      if (queuedReply) {
        tick();
        await until(() => voice.active.size === 0);
        return voice.speakReply({ ...request, receiptOnly: true });
      }
      return (await f.status(id)).body;
    }
    if (queuedReply) {
      voice.synthesis.candidates = () => [{ id: 'fixture', generation: '1' }];
      mockReplySynthesis(voice, () => syntheses++);
      assert.equal(voice.speakReply(request).status, 'pending');
      assert.equal((await poll()).status, 'pending');
    } else {
      assert.equal((await f.submit({ deliveryId: id })).body.status, 'pending');
    }
    const staged = voice.load(id);
    assert(staged.pendingPcm);
    assert.equal((await poll()).status, 'pending');
    assert.equal(voice.load(id).pendingPcm, staged.pendingPcm);
    assert.equal(f.backend.submissions.length, 0);

    full = false;
    await poll();
    assert.equal(f.backend.submissions.length, 1);
    assert.equal(f.backend.submissions[0].deliveryId, staged.operationId);
    assert.equal(f.backend.submissions[0].pcmBase64, staged.pendingPcm);
    assert.equal(f.backend.textSubmissions.length, 0);
    assert.equal(syntheses, Number(queuedReply));
  });
}

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
  const result = await adapter.voiceSend.status(job, null, { observeOnly: true });
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

for (const [loseResponse, changed] of [
  [false, 'roster'],
  [false, 'provider'],
  [true, 'provider'],
]) {
  test(
    'local voice receipts use their saved scope after a permission change, ' + changed + ', lost=' + loseResponse,
    async t => {
      const f = await fixture(t, { loseResponse });
      const adapter = f.adapter();
      const voice = adapter.voiceSend;
      const conversationKey = 'wechat:private:wxid_other';
      voice.synthesis.candidates = () => [{ id: 'fixture', generation: '1' }];
      assert.equal((await f.submit({ conversationKey })).body.status, 'pending');
      const original = voice.load('fixture-id');
      assert.equal(Boolean(original.pendingPcm), loseResponse);
      f.backend.confirmLatest();
      if (changed === 'roster') {
        f.config.wechat.whitelist.private = f.config.wechat.whitelist.private.filter(id => id !== 'wxid_other');
        f.saveConfig();
      } else voice.synthesis.candidates = () => [];
      const nativeCheck = t.mock.method(adapter, 'checkNative', async () => assert.fail('a receipt is not new input'));
      const request = adapter.desktopSender.request.bind(adapter.desktopSender);
      let lookups = 0;
      t.mock.method(adapter.desktopSender, 'request', async (operation, body, options) => {
        if (operation === 'lookup') {
          lookups++;
          assert.deepEqual(body, {
            account: original.account,
            accountRef: original.accountRef,
            kind: original.kind,
            target: original.target,
            rosterGrant: original.rosterGrant,
            deliveryId: original.operationId,
            observeOnly: true,
          });
        }
        return request(operation, body, options);
      });
      const receipt = await f.status();
      assert.equal(receipt.http, 200);
      assert.equal(receipt.body.status, 'confirmed');
      assert.equal(receipt.body.serverMessageId, '900000000000000001');
      assert.equal(voice.load('fixture-id').operationId, original.operationId);
      assert.equal(voice.load('fixture-id').pendingPcm, undefined);
      assert.equal(lookups, 1);
      assert.equal(nativeCheck.mock.callCount(), 0);
      assert.equal((await f.submit({ conversationKey })).body.status, 'confirmed');
      assert.equal((await f.submit()).body.error, 'VOICE_DELIVERY_ID_CONFLICT');
      assert.equal(f.backend.submissions.length, 1);

      if (changed === 'roster') {
        fs.writeFileSync(
          path.join(f.directory, 'state/weflow/active-account.json'),
          JSON.stringify({ id: 'e'.repeat(64) }),
        );
        const switched = await f.status();
        assert.equal(switched.http, 409);
        assert.equal(switched.body.error, 'VOICE_ACCOUNT_OR_TARGET_CHANGED');
      }
    },
  );
}

test('a local voice with proof of absence still needs current permission before resuming', async t => {
  const f = await fixture(t);
  const adapter = f.adapter();
  const voice = adapter.voiceSend;
  const conversationKey = 'wechat:private:wxid_other';
  voice.synthesis.candidates = () => [{ id: 'fixture', generation: '1' }];
  const dispatch = t.mock.method(adapter, 'dispatchDesktop', async () => {
    throw Error('interrupted before desktop admission');
  });
  assert.equal((await f.submit({ conversationKey })).body.status, 'pending');
  const original = voice.load('fixture-id');
  assert(original.pendingPcm);
  f.config.wechat.whitelist.private = f.config.wechat.whitelist.private.filter(id => id !== 'wxid_other');
  f.saveConfig();
  const request = adapter.desktopSender.request.bind(adapter.desktopSender);
  let lookups = 0;
  t.mock.method(adapter.desktopSender, 'request', async (operation, body, options) => {
    if (operation === 'lookup') {
      lookups++;
      assert.equal(body.deliveryId, original.operationId);
      assert.equal(body.observeOnly, true);
    }
    return request(operation, body, options);
  });
  const result = await f.status();
  assert.equal(result.http, 403);
  assert.equal(result.body.error, 'VOICE_CONVERSATION_NOT_ALLOWED');
  assert.equal(lookups, 1);
  assert.equal(dispatch.mock.callCount(), 1);
  assert.equal(f.backend.submissions.length, 0);
});

test('claimed confirmation with no segments keeps the original voice intent recoverable', async t => {
  const f = await fixture(t);
  f.backend.nextResult = { state: 'confirmed', pending: false, submission: 'confirmed', confirmed: true, segments: [] };
  const result = await f.submit();
  const saved = f.adapter().voiceSend.load('fixture-id');
  assert.equal(result.body.status, 'pending');
  assert(saved.pendingPcm);
  assert.equal(saved.inputError, 'VOICE_DESKTOP_RECEIPT_INVALID');
  const operation = saved.operationId;
  f.backend.results.get(operation).segments = [segment(operation, 0, saved.durationMs, '900000000000000001')];
  await f.restart();
  assert.equal((await f.status()).body.status, 'confirmed');
  assert.equal(f.adapter().voiceSend.load('fixture-id').operationId, operation);
  assert.equal(f.adapter().voiceSend.load('fixture-id').pendingPcm, undefined);
  assert.equal(f.backend.submissions.length, 1);
});

test('invalid later voice receipts preserve the last valid partial snapshot', async t => {
  const f = await fixture(t);
  const wavBase64 = pcmWave(Buffer.alloc(32000 * 9).toString('base64')).toString('base64');
  await f.submit({ wavBase64 });
  const operation = f.adapter().voiceSend.load('fixture-id').operationId;
  const first = segment(operation, 0, 8000, '900000000000000001');
  const second = segment(operation, 1);
  const admitted = { ...f.backend.results.get(operation), segments: [first, second] };
  f.backend.results.set(operation, admitted);
  assert.equal((await f.status()).body.status, 'pending');
  const initial = f.adapter().voiceSend.load('fixture-id');
  const withoutEvidence = [first, { ...second, state: 'confirmed', source: 'desktop-acoustic-match' }];
  for (const update of [
    { segments: [] },
    { segments: [{ ...first, serverId: '900000000000000099' }, second] },
    { segments: withoutEvidence },
    { segments: withoutEvidence, state: 'confirmed', pending: false, confirmed: true },
  ]) {
    f.backend.results.set(operation, { ...admitted, ...update });
    assert.equal((await f.status()).body.status, 'pending');
    const saved = f.adapter().voiceSend.load('fixture-id');
    assert.deepEqual(saved.segments, initial.segments);
    assert.equal(saved.nativeStatus, 'pending');
    assert.equal(saved.queryError, 'VOICE_DESKTOP_RECEIPT_INVALID');
  }
  f.backend.confirmLatest();
  assert.equal((await f.status()).body.status, 'confirmed');
  assert.equal(f.backend.submissions.length, 1);
});

test('an incomplete DSH voice acknowledgement remains in the recovery queue after restart', async t => {
  const f = await fixture(t);
  const voice = f.adapter().voiceSend;
  const tick = voice.tickReplies.bind(voice);
  voice.tickReplies = () => {};
  voice.synthesis.candidates = () => [{ id: 'fixture', generation: '1' }];
  mockReplySynthesis(voice);
  f.backend.nextResult = { state: 'confirmed', confirmed: true, pending: false, segments: [] };
  const request = { kind: 'private', target, text: 'fixture', deliveryId: 'ad'.repeat(32) };
  const id = 'dsh-' + request.deliveryId;
  assert.equal(voice.speakReply(request).status, 'pending');
  tick();
  await until(() => f.backend.submissions.length === 1 && voice.replySynthesis.size === 0);
  const previous = voice.load(id);
  assert(voice.replies.has(id));
  assert(previous.pendingPcm);
  const createTime = Math.floor(Date.now() / 1000) - 5;
  f.backend.results.get(previous.operationId).segments = [
    {
      ...segment(previous.operationId, 0, previous.durationMs, '900000000000000001'),
      receipt: { createTime, localId: '2', sourceShard: 'a'.repeat(64) },
    },
  ];

  await f.restart();
  const recovered = f.adapter().voiceSend;
  recovered.synthesis.generate = () => assert.fail('the recovery must reuse the original voice operation');
  recovered.tickReplies();
  await until(() => recovered.load(id).confirmed === true);
  const bridge = new WechatOneBotAdapter();
  bridge.server.action = async action => {
    assert.equal(action, 'get_voice_delivery');
    return { data: recovered.speakReply({ ...request, receiptOnly: true }) };
  };
  assert.deepEqual(
    await bridge.inspectReplyReceipt(
      { kind: 'private', conversation_id: target },
      { deliveryId: request.deliveryId, voiceText: request.text },
    ),
    {
      status: 'confirmed',
      sentAt: createTime * 1000,
      readerOrder: String(createTime).padStart(20, '0') + '-' + '2'.padStart(20, '0') + '-' + 'a'.repeat(64),
    },
  );
  assert.equal(recovered.load(id).operationId, previous.operationId);
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
  };
  const records = () =>
    ['state/realtime-replies', 'state/realtime-replies/pending'].flatMap(folder => {
      const directory = path.join(f.directory, folder);
      return !fs.existsSync(directory)
        ? []
        : fs
            .readdirSync(directory)
            .filter(name => name.endsWith('.json'))
            .map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
    });
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

  const realtime = f.adapter().realtime;
  const saved = realtime.load(record.id);
  realtime.save({ ...saved, stage: 'sent', voiceStatus: 'unconfirmed' });
  const replayed = await realtime.handle(saved, () => assert.fail('the archived reply must not be admitted again'));
  assert.deepEqual(replayed, { id: record.id, mode: 'voice', status: 'confirmed' });
  assert.equal(realtime.load(record.id).voiceStatus, 'confirmed');
  assert.deepEqual([f.backend.submissions.length, f.backend.textSubmissions.length], [1, 0]);
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

test('Realtime keeps generated audio while Reader is temporarily offline before desktop admission', async t => {
  const f = await fixture(t);
  const adapter = f.adapter();
  const realtime = adapter.realtime;
  realtime.tick = () => {};
  const record = {
    version: 1,
    id: 'realtime-' + 'a2'.repeat(32),
    kind: 'private',
    target,
    mode: 'voice',
    text: 'fixture Realtime speech',
    stage: 'decided',
    rawid: 'b2'.repeat(32),
    rosterGrant: 'legacy',
    account: adapter.account,
    accountRef: adapter.accountRef,
    startedAt: Date.now(),
  };
  realtime.save(record);
  realtime.audio.set(record.id, wav);
  realtime.audioBytes += wav.length;
  const read = adapter.reader.bind(adapter);
  const offline = t.mock.method(adapter, 'reader', async (route, ...args) => {
    if (route === '/api/v1/reader/status') throw Error('READER_HTTP_TIMEOUT');
    return read(route, ...args);
  });
  await assert.rejects(
    realtime.sendVoice(record, () => true),
    /READER_HEALTH_FAILED/,
  );
  assert.equal(realtime.audio.has(record.id), true);
  assert.equal(realtime.audioBytes, wav.length);
  assert.equal(f.backend.submissions.length, 0);
  assert.equal(f.backend.textSubmissions.length, 0);

  offline.mock.restore();
  await realtime.sendVoice(record, () => true);
  assert.equal(f.backend.submissions.length, 1);
  assert.equal(f.backend.textSubmissions.length, 0);
  assert.equal(realtime.audioBytes, 0);
});

test('a retired Realtime voice waits for its in-flight background receipt check', async t => {
  const f = await fixture(t);
  const { realtime, voiceSend, account, accountRef } = f.adapter();
  const adapter = f.adapter();
  realtime.tick = () => {};
  let permitted = true;
  adapter.realtimePermitted = () => () => permitted;
  const selected = { id: 'fixture', generation: '1' };
  voiceSend.synthesis.candidates = () => [selected];
  const record = {
    version: 1,
    id: 'realtime-' + 'e7'.repeat(32),
    kind: 'private',
    target,
    mode: 'voice',
    input: 'text',
    text: 'fixture Realtime speech',
    stage: 'decided',
    rawid: 'e8'.repeat(32),
    rosterGrant: 'legacy',
    account,
    accountRef,
    startedAt: Date.now(),
    voicePlugin: voiceSend.pluginGrant(await adapter.checkNative(), 'private', target, selected, dialogueFeature),
  };
  realtime.save(record);
  realtime.audio.set(record.id, wav);
  realtime.audioBytes += wav.length;
  await realtime.sendPending(record);
  const job = voiceSend.load(record.id);
  assert.equal(voiceSend.response(job).status, 'pending');
  const polls = [...voiceSend.receiptPolls];
  assert.equal(polls.length, 1);

  const delayed = Promise.withResolvers();
  const observations = [];
  const request = adapter.desktopSender.request.bind(adapter.desktopSender);
  t.mock.method(adapter.desktopSender, 'request', async (action, payload, options) => {
    if (action !== 'lookup' || payload.deliveryId !== job.operationId) return request(action, payload, options);
    const result = await request(action, payload, options);
    observations.push(payload.observeOnly);
    if (observations.length === 1) await delayed.promise;
    return result;
  });
  try {
    await until(() => observations.length === 1, 'the background check read the pending receipt');
    assert.equal(voiceSend.active.has(record.id), true);
    f.backend.confirmLatest();
    permitted = false;
    await realtime.sendPending(realtime.load(record.id));
  } finally {
    delayed.resolve();
  }

  await until(() => !voiceSend.active.has(record.id), 'the older pending snapshot has settled');
  const retired = realtime.load(record.id);
  assert.equal(
    retired.voiceStatus === 'confirmed' && voiceSend.response(voiceSend.load(record.id)).status !== 'confirmed',
    false,
    'the late pending snapshot must not erase a confirmed voice receipt',
  );
  assert.deepEqual(observations, [true]);
  assert.equal(retired.observeOnly, true);
  assert.equal(retired.stage, 'decided');

  await realtime.sendPending(retired);
  await Promise.all(polls);
  assert.deepEqual(observations, [true, true]);
  assert.equal(realtime.load(record.id).voiceStatus, 'confirmed');
  assert.equal(voiceSend.response(voiceSend.load(record.id)).status, 'confirmed');
  assert.equal(f.backend.submissions.length, 1);
  assert.equal(f.backend.textSubmissions.length, 0);
});

for (const scenario of [
  'restart',
  'passive status',
  'lookup unavailable',
  'grant withdrawn',
  'late withdrawal',
  'queue full',
]) {
  test('Realtime resumes the original staged audio only with permission, ' + scenario, async t => {
    const f = await fixture(t);
    const adapter = f.adapter();
    const realtime = adapter.realtime;
    const voice = adapter.voiceSend;
    realtime.tick = () => {};
    const selected = { id: 'fixture', generation: '1' };
    voice.synthesis.candidates = () => [selected];
    const record = {
      version: 1,
      id: 'realtime-' + 'ae'.repeat(32),
      kind: 'private',
      target,
      mode: 'voice',
      input: 'text',
      text: 'fixture speech',
      stage: 'decided',
      rawid: 'be'.repeat(32),
      rosterGrant: 'legacy',
      account: adapter.account,
      accountRef: adapter.accountRef,
      startedAt: Date.now(),
      voicePlugin: voice.pluginGrant(await adapter.checkNative(), 'private', target, selected, dialogueFeature),
    };
    realtime.save(record);
    realtime.audio.set(record.id, wav);
    realtime.audioBytes += wav.length;
    const blocked = t.mock.method(adapter, 'dispatchDesktop', async () => {
      if (scenario === 'queue full')
        throw Object.assign(Error('desktop queue is full'), { code: 'DESKTOP_STORAGE_LIMIT', attempted: false });
      throw Object.assign(Error('desktop temporarily busy before admission'), { code: 'DESKTOP_CONFIGURATION_BUSY' });
    });
    assert.equal((await realtime.sendVoice(record, () => true)).status, 'pending');
    blocked.mock.restore();
    const saved = voice.load(record.id);
    assert(saved.pendingPcm);
    assert.equal(f.backend.submissions.length, 0);
    assert.equal(realtime.audioBytes, 0);

    if (scenario === 'passive status' || scenario === 'lookup unavailable') {
      const desktop = adapter.desktopSender.request.bind(adapter.desktopSender);
      const lookup = t.mock.method(adapter.desktopSender, 'request', async (operation, payload, options) => {
        if (operation === 'lookup') {
          assert.equal(payload.deliveryId, saved.operationId);
          if (scenario === 'lookup unavailable') throw Error('temporary lookup failure');
          assert.equal(payload.observeOnly, true);
        }
        return desktop(operation, payload, options);
      });
      const status =
        scenario === 'passive status' ? (await f.status(record.id)).body : await realtime.sendVoice(record, () => true);
      assert.equal(status.status, 'pending');
      assert(lookup.mock.calls.some(call => call.arguments[0] === 'lookup'));
      assert.equal(voice.load(record.id).pendingPcm, saved.pendingPcm);
      assert.equal(f.backend.submissions.length, 0);
      lookup.mock.restore();
    }

    const withdrawn = scenario === 'grant withdrawn' || scenario === 'late withdrawal';
    if (scenario === 'late withdrawal') {
      let checks = 0;
      assert.equal((await realtime.sendVoice(record, () => ++checks === 1)).status, 'pending');
      assert.equal(checks, 2);
      assert.equal(f.backend.submissions.length, 0);
    }
    if (withdrawn) {
      f.config.wechat.rosterGrants = { ['wechat:private:' + target]: 'replacement-grant' };
      f.saveConfig();
      await realtime.sendPending(record);
      assert.equal(voice.load(record.id).rejected, true);
      assert.equal(voice.load(record.id).pendingPcm, undefined);
      assert.equal(f.backend.submissions.length, 0);
    } else {
      if (scenario === 'restart') {
        await f.restart();
        const recovered = f.adapter();
        recovered.voiceSend.synthesis.candidates = () => [selected];
        await recovered.realtime.sendPending(recovered.realtime.load(record.id));
      } else {
        await realtime.sendVoice(record, () => true);
      }
      assert.equal(f.backend.submissions.length, 1);
      assert.equal(f.backend.submissions[0].deliveryId, saved.operationId);
      assert.equal(f.backend.submissions[0].pcmBase64, saved.pendingPcm);
    }
    assert.equal(f.backend.textSubmissions.length, 0);
  });
}

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
  await until(() => f.records()[0]?.textStatus === 'confirmed', 'independent outbound receipt');
  assert.equal(f.backend.textSubmissions.length, 1);
  assert.equal(f.records()[0].textStatus, 'confirmed');
});

for (const boundary of ['roster revoked', 'desktop configuration busy']) {
  test('Realtime text keeps the original receipt after ' + boundary, async t => {
    const f = await fixture(t);
    const adapter = f.adapter();
    const realtime = adapter.realtime;
    realtime.tick = () => {};
    let permitted = true;
    adapter.realtimePermitted = () => () => permitted;
    const record = {
      version: 1,
      id: 'realtime-' + 'ba'.repeat(32),
      kind: 'private',
      target,
      mode: 'text',
      text: 'fixture Realtime text',
      stage: 'decided',
      rawid: 'ab'.repeat(32),
      rosterGrant: 'legacy',
      account: adapter.account,
      accountRef: adapter.accountRef,
      startedAt: Date.now(),
    };
    f.backend.paused = true;
    realtime.save(record, true);
    await realtime.sendPending(record);
    assert.equal(realtime.load(record.id).textStatus, 'submitted');
    f.backend.resumeText();
    const sent = f.backend.textSubmissions[0];
    let configurationBusy = boundary === 'desktop configuration busy';
    if (!configurationBusy) {
      permitted = false;
      f.config.wechat.whitelist.private = f.config.wechat.whitelist.private.filter(id => id !== target);
      f.saveConfig();
      adapter.reload();
    }
    const desktopRequest = adapter.desktopSender.request.bind(adapter.desktopSender);
    const lookup = t.mock.method(adapter.desktopSender, 'request', async (operation, payload, options) => {
      if (operation === 'lookup') {
        assert.equal(payload.deliveryId, sent.deliveryId);
        assert.equal(payload.observeOnly === true, !permitted);
        if (configurationBusy) {
          configurationBusy = false;
          throw Object.assign(Error('desktop configuration busy'), { code: 'DESKTOP_CONFIGURATION_BUSY' });
        }
      }
      return desktopRequest(operation, payload, options);
    });
    await realtime.sendPending(realtime.load(record.id));
    if (boundary === 'desktop configuration busy') {
      assert.equal(realtime.load(record.id).stage, 'decided');
      assert.equal(realtime.load(record.id).textStatus, 'submitted');
      await realtime.sendPending(realtime.load(record.id));
    }
    assert(lookup.mock.calls.some(call => call.arguments[0] === 'lookup'));
    assert.equal(realtime.load(record.id).textStatus, 'confirmed');
    assert.equal(f.backend.textSubmissions.length, 1);
  });
}

test('a retired Realtime receipt allows a new reply in the same chat and stays read-only after restart', async t => {
  const f = await fixture(t);
  let adapter = f.adapter();
  let realtime = adapter.realtime;
  let tick = realtime.tick.bind(realtime);
  realtime.tick = () => {};
  const startedAt = Date.now();
  const makeRecord = digit => ({
    version: 1,
    id: 'realtime-' + digit.repeat(64),
    kind: 'private',
    target,
    mode: 'text',
    input: 'text',
    text: 'fixture reply ' + digit,
    stage: 'decided',
    rawid: digit.repeat(64),
    rosterGrant: 'legacy',
    account: adapter.account,
    accountRef: adapter.accountRef,
    startedAt: startedAt + Number(digit),
  });
  const old = makeRecord('1');
  const fresh = makeRecord('2');
  let permitted = true;
  adapter.realtimePermitted = () => () => permitted;
  f.backend.paused = true;
  realtime.save(old);
  await realtime.sendPending(old);
  assert.equal(realtime.load(old.id).textStatus, 'submitted');
  const operation = [...f.backend.pausedTexts.keys()][0];
  const held = Promise.withResolvers();
  const read = adapter.desktopSender.request.bind(adapter.desktopSender);
  const oldChecks = [];
  adapter.desktopSender.request = async (action, payload, options) => {
    if (action === 'lookup' && payload.deliveryId === operation) {
      oldChecks.push(payload.observeOnly);
      await held.promise;
    }
    return read(action, payload, options);
  };
  try {
    permitted = false;
    tick();
    await new Promise(resolve => setImmediate(resolve));
    tick();
    await until(() => oldChecks.length === 1);
    permitted = true;
    f.backend.paused = false;
    realtime.save(fresh);
    tick();
    await until(() => realtime.load(fresh.id).textStatus === 'confirmed');
    assert.equal(realtime.load(old.id).observeOnly, true);
    assert.equal(realtime.load(old.id).textStatus, 'submitted');
    assert.deepEqual(
      f.backend.textSubmissions.map(item => item.text),
      [fresh.text],
    );
  } finally {
    held.resolve();
    await realtime.close();
  }

  await f.restart();
  adapter = f.adapter();
  realtime = adapter.realtime;
  tick = realtime.tick.bind(realtime);
  realtime.tick = () => {};
  adapter.realtimePermitted = () => () => true;
  const restoredChecks = [];
  const restored = adapter.desktopSender.request.bind(adapter.desktopSender);
  adapter.desktopSender.request = async (action, payload, options) => {
    if (action === 'lookup' && payload.deliveryId === operation) restoredChecks.push(payload.observeOnly);
    return restored(action, payload, options);
  };
  tick();
  await realtime.close();
  assert(oldChecks.length > 0 && oldChecks.every(check => check === true));
  assert(restoredChecks.length > 0 && restoredChecks.every(check => check === true));
  assert.equal(realtime.load(old.id).observeOnly, true);
  assert.deepEqual(
    f.backend.textSubmissions.map(item => item.text),
    [fresh.text],
  );
});

test('old Realtime observations leave both current receipt slots free', async t => {
  const f = await fixture(t);
  const { realtime, account, accountRef } = f.adapter();
  const tick = realtime.tick.bind(realtime);
  realtime.tick = () => {};
  const held = Promise.withResolvers();
  const seen = [];
  const add = (target, observeOnly) => {
    realtime.pending.set(target, {
      id: target,
      account,
      accountRef,
      rosterGrant: 'legacy',
      kind: 'private',
      target,
      startedAt: seen.length,
      observeOnly,
    });
    realtime.awaitingReceipt.add(target);
  };
  realtime.sendPending = async record => {
    seen.push(record.target);
    await held.promise;
  };
  try {
    add('old-first', true);
    add('old-second', true);
    tick();
    add('current-first', undefined);
    add('current-second', undefined);
    tick();
    assert.deepEqual(seen, ['old-first', 'old-second', 'current-first', 'current-second']);
    assert.equal(realtime.receiptChecks.size, 2);
  } finally {
    held.resolve();
    await realtime.close();
  }
});

for (const [mixed, restarted] of [
  [false, false],
  [true, false],
  [true, true],
]) {
  test(`slow Realtime receipts leave another chat free to admit, mixed=${mixed}, restarted=${restarted}`, async t => {
    const f = await fixture(t);
    let adapter = f.adapter(),
      realtime = adapter.realtime,
      tick = realtime.tick.bind(realtime);
    realtime.tick = () => {};
    adapter.realtimePermitted = () => () => true;
    const startedAt = Date.now();
    const record = (ordinal, target, mode = 'text', kind = 'private') => ({
      version: 1,
      id: 'realtime-' + String(ordinal).repeat(64),
      kind,
      target,
      mode,
      input: 'text',
      text: 'fixture reply ' + ordinal,
      stage: 'decided',
      rawid: String(ordinal + 4).repeat(64),
      rosterGrant: 'legacy',
      account: adapter.account,
      accountRef: adapter.accountRef,
      startedAt: startedAt + ordinal,
    });
    f.backend.paused = true;
    const first = record(1, target, mixed ? 'voice' : 'text');
    const second = record(2, 'wxid_other');
    const selected = { id: 'fixture', generation: '1' };
    if (mixed) {
      adapter.voiceSend.synthesis.candidates = () => [selected];
      first.voicePlugin = adapter.voiceSend.pluginGrant(
        await adapter.checkNative(),
        first.kind,
        first.target,
        selected,
        dialogueFeature,
      );
      realtime.audio.set(first.id, wav);
      realtime.audioBytes += wav.length;
    }
    for (const item of [first, second]) {
      realtime.save(item);
      await realtime.sendPending(item);
    }
    const operations = new Set([
      ...f.backend.pausedTexts.keys(),
      ...f.backend.submissions.map(item => item.deliveryId),
    ]);
    assert.equal(operations.size, 2);
    if (restarted) {
      // The desktop intent can outlive a missing acknowledgement in Realtime's own outbox.
      delete second.textStatus;
      realtime.save(second);
      await f.restart();
      adapter = f.adapter();
      adapter.realtimePermitted = () => () => true;
      adapter.voiceSend.synthesis.candidates = () => [selected];
      realtime = adapter.realtime;
      tick = realtime.tick.bind(realtime);
      realtime.tick = () => {};
    }

    const delayed = Promise.withResolvers();
    const held = new Set();
    const request = adapter.desktopSender.request.bind(adapter.desktopSender);
    t.mock.method(adapter.desktopSender, 'request', async (operation, payload, options) => {
      if (['lookup', 'query'].includes(operation) && operations.has(payload.deliveryId)) {
        held.add(payload.deliveryId);
        await delayed.promise;
      }
      return request(operation, payload, options);
    });
    const next = record(3, chat, 'text', 'group');
    const sameChat = record(4, target);
    try {
      tick();
      await until(() => held.size === 2, 'both older receipt checks are in flight');
      realtime.save(next);
      realtime.save(sameChat);
      tick();
      await until(() => realtime.load(next.id).textStatus === 'submitted', 'admission in a different chat');
      assert.equal(realtime.load(sameChat.id).textStatus, undefined);
      assert.equal(f.backend.pausedTexts.size + f.backend.submissions.length, 3);
    } finally {
      delayed.resolve();
      await realtime.close();
    }
    f.backend.resumeText();
    if (mixed) f.backend.confirmLatest();
    for (let i = 0; i < 4 && realtime.pending.size; i++) {
      tick();
      await realtime.close();
    }
    assert.equal(realtime.pending.size, 0);
    assert.equal(realtime.load(sameChat.id).textStatus, 'confirmed');
    assert.equal(f.backend.textSubmissions.at(-1).text, sameChat.text);
    assert.equal(f.backend.textSubmissions.length + f.backend.submissions.length, 4);
  });
}

for (const restarted of [false, true]) {
  test('unacknowledged Realtime admissions leave receipt slots available, restarted=' + restarted, async t => {
    const f = await fixture(t);
    let adapter = f.adapter();
    let realtime = adapter.realtime;
    let tick = realtime.tick.bind(realtime);
    const selected = { id: 'fixture', generation: '1' };
    const configure = () => {
      realtime.tick = () => {};
      adapter.realtimePermitted = () => () => true;
      adapter.voiceSend.synthesis.candidates = () => [selected];
    };
    configure();
    f.backend.paused = true;
    const start = Date.now();
    const record = (number, kind, target, mode) => ({
      version: 1,
      id: 'realtime-' + String(number).repeat(64),
      rawid: String(number + 4).repeat(64),
      kind,
      target,
      mode,
      input: 'text',
      text: 'fixture reply ' + number,
      stage: 'decided',
      rosterGrant: 'legacy',
      account: adapter.account,
      accountRef: adapter.accountRef,
      startedAt: start + number,
    });
    const voice = record(1, 'private', target, 'voice');
    voice.voicePlugin = adapter.voiceSend.pluginGrant(
      await adapter.checkNative(),
      voice.kind,
      voice.target,
      selected,
      dialogueFeature,
    );
    realtime.audio.set(voice.id, wav);
    realtime.audioBytes += wav.length;
    const text = record(2, 'private', 'wxid_other', 'text');
    const admitted = record(3, 'group', chat, 'text');
    const unacknowledged = new Set();
    const dispatch = adapter.dispatchDesktop.bind(adapter);
    adapter.dispatchDesktop = async (operation, body, ...args) => {
      if (body.target === voice.target || body.target === text.target) {
        unacknowledged.add(body.deliveryId);
        throw Error('lost before admission');
      }
      return dispatch(operation, body, ...args);
    };
    for (const item of [voice, text, admitted]) {
      realtime.save(item);
      await realtime.sendPending(item);
    }
    assert.equal(unacknowledged.size, 2);
    assert.equal(f.backend.pausedTexts.size, 1);
    const [acceptedOperation] = f.backend.pausedTexts.keys();

    if (restarted) {
      await f.restart();
      adapter = f.adapter();
      realtime = adapter.realtime;
      tick = realtime.tick.bind(realtime);
      configure();
    }
    const gate = Promise.withResolvers();
    const held = new Set();
    let checked = false;
    const request = adapter.desktopSender.request.bind(adapter.desktopSender);
    t.mock.method(adapter.desktopSender, 'request', async (operation, body, options) => {
      if (operation === 'lookup' && unacknowledged.has(body.deliveryId)) {
        held.add(body.deliveryId);
        await gate.promise;
      }
      if (operation === 'lookup' && body.deliveryId === acceptedOperation) checked = true;
      return request(operation, body, options);
    });
    try {
      tick();
      await until(() => held.size === 2);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(checked, true);
    } finally {
      gate.resolve();
      await realtime.close();
    }
  });
}

test('new Realtime admissions do not restart the receipt rotation', async t => {
  const f = await fixture(t);
  const realtime = f.adapter().realtime;
  const tick = realtime.tick.bind(realtime);
  realtime.tick = () => {};
  const checks = [];
  const admission = [];
  realtime.sendPending = async record => {
    if (record.textStatus === 'submitted') checks.push(record.id);
    else {
      admission.push(record.id);
      realtime.pending.delete(record.id);
    }
  };
  const add = (id, order, textStatus) => {
    realtime.pending.set(id, {
      id,
      account: realtime.adapter.account,
      accountRef: realtime.adapter.accountRef,
      mode: 'text',
      kind: 'private',
      target: id,
      startedAt: order,
      textStatus,
    });
  };
  for (const [index, id] of ['a', 'b', 'c', 'd'].entries()) {
    add(id, index, 'submitted');
    realtime.awaitingReceipt.add(id);
  }
  for (let round = 0; round < 3; round++) {
    add('new-a-' + round, 10 + round * 2);
    add('new-b-' + round, 11 + round * 2);
    tick();
    await realtime.close();
  }
  assert.deepEqual(checks, ['a', 'b', 'c', 'd', 'a', 'b']);
  assert.equal(admission.length, 6);
});

test('paused Realtime replies acknowledge both messages and resume in order after restart', async t => {
  const f = await realtimeFixture(t, [
    { mode: 'text', text: '第一条' },
    { mode: 'text', text: '第二条' },
  ]);
  f.backend.paused = true;
  f.backend.emitVoice(f.textEvent('paused-1', '第一问'));
  f.backend.emitVoice(f.textEvent('paused-2', '第二问'));
  await f.settle();
  assert.equal(f.records().filter(row => row.stage === 'decided').length, 2);
  await until(() => f.backend.pausedTexts.size === 1, 'one admitted and paused delivery');
  assert.equal(f.backend.textSubmissions.length, 0);
  await f.restart();
  f.backend.resumeText();
  await until(() => f.records().filter(row => row.textStatus === 'confirmed').length === 2, 'both outbox receipts');
  assert.deepEqual(
    f.backend.textSubmissions.map(item => item.text),
    ['第一条', '第二条'],
  );
  assert.equal(f.events.filter(event => event.type === 'session.update').length, 2);
});

test('after losing unsent Realtime audio, restart sends the chosen text without selecting a TTS provider', async t => {
  const f = await realtimeFixture(t, [{ mode: 'voice', text: '保留已经决定的内容。' }]);
  f.adapter().realtime.tick = () => {};
  f.backend.emitVoice(f.textEvent('lost-audio', '用语音说'));
  await f.settle();
  assert.equal(f.records()[0].stage, 'decided');
  await f.restart();
  f.adapter().voiceSend.generateAndSend = () => assert.fail('must not reroute to TTS');
  await until(() => f.records()[0]?.textStatus === 'confirmed', 'restart text fallback');
  assert.equal(f.records()[0].voiceError, 'VOICE_REALTIME_AUDIO_UNAVAILABLE');
  assert.deepEqual(
    f.backend.textSubmissions.map(item => item.text),
    ['保留已经决定的内容。'],
  );
  assert.equal(f.backend.submissions.length, 0);
  assert.equal(f.events.filter(event => event.type === 'session.update').length, 1);
});
