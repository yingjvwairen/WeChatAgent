import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReplyDeliveryControls } from '../packages/dsh-social-bridge-plugin/reply-delivery-controls.mjs';
import { TextDeliveryStore } from './text-delivery-store.mjs';
import { WechatOneBot } from './wechat-onebot.mjs';
import { VoiceSend } from './voice-send.mjs';
import { selectPluginAccount } from './test-fixtures/plugin-account.mjs';

const key = 'wechat:private:123',
  id = 'a'.repeat(64);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-reply-controls-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  fs.mkdirSync(path.join(root, 'config'));
  const config = { wechat: { whitelist: { groups: [], private: ['123'] } } };
  const save = () => fs.writeFileSync(path.join(root, 'config/wechatagent.json'), JSON.stringify(config));
  save();
  return { root, config, save, create: () => new ReplyDeliveryControls(root, 'legacy') };
}
test('restarts preserve per-chat pause, part cancellation, and claimed submissions', t => {
  const f = fixture(t),
    operator = f.create(),
    engine = f.create(),
    grant = engine.scope(key);
  const part = { deliveryId: id, voiceText: 'fixture', state: 'queued' };
  operator.control({ key, grant, operation: 'pause', revision: 0 });
  assert(engine.register(key, grant, [part]));
  assert.equal(engine.claim(key, grant, id), 'paused');
  assert.equal(f.create().list(key).held, true);
  assert.equal(f.create().list(key).replies[0].preview, part.voiceText);
  operator.control({ key, grant, operation: 'resume', revision: 1 });
  operator.control({ key, grant, id, operation: 'pause', revision: 0 });
  assert.throws(
    () => f.create().control({ key, grant, id, operation: 'cancel', revision: 0 }),
    /DELIVERY_CONTROL_CHANGED/,
  );
  assert.equal(engine.claim(key, grant, id), 'paused');
  operator.control({ key, grant, id, operation: 'resume', revision: 1 });
  assert.equal(engine.claim(key, grant, id), 'send');
  assert.equal(f.create().claim(key, grant, id), 'submitted');
  assert.throws(
    () => operator.control({ key, grant, id, operation: 'cancel', revision: 3 }),
    /DELIVERY_CONTROL_CHANGED/,
  );
  const second = { deliveryId: 'b'.repeat(64), text: 'next', state: 'queued' };
  engine.register(key, grant, [second]);
  assert.equal(
    f
      .create()
      .list(key)
      .replies.find(row => row.id === second.deliveryId).preview,
    second.text,
  );
  operator.control({ key, grant, id: second.deliveryId, operation: 'cancel', revision: 0 });
  assert.equal(f.create().claim(key, grant, second.deliveryId), 'cancelled');
  f.config.wechat.rosterGrants = { [key]: 'new-grant' };
  f.save();
  assert.equal(engine.claim(key, grant, id), 'cancelled');
  assert.equal(operator.list(key).replies.length, 0);
  assert.throws(() => operator.control({ key, grant, operation: 'pause', revision: 2 }), /DELIVERY_CONTROL_CHANGED/);
});
test('assistant input authorization follows the original administrator and work mode', t => {
  const f = fixture(t),
    controls = f.create();
  f.config.wechat.workModes = { [key]: 'assistant' };
  f.config.wechat.assistant = { administrators: ['123', 'another-admin'] };
  f.save();
  const grant = controls.scope(key);
  assert.equal(controls.requireAssistantReply(key, grant, [id], '123'), true);
  assert.equal(controls.requireAssistantReply(key, grant, [id], '123'), true);
  assert.throws(() => controls.requireAssistantReply(key, grant, [id], 'another-admin'), /DELIVERY_CONTROL_CHANGED/);
  assert.equal(f.create().inputWithdrawn(key, grant, id), false);
  f.config.wechat.workModes[key] = 'social';
  f.save();
  assert.equal(f.create().inputWithdrawn(key, grant, id), true);
  f.config.wechat.workModes[key] = 'assistant';
  f.config.wechat.assistant.administrators = ['another-admin'];
  f.save();
  assert.equal(f.create().inputWithdrawn(key, grant, id), true);
});

test('receipt-only recovery for missing text and voice never invokes a new submission or fallback', async () => {
  const adapter = Object.assign(Object.create(WechatOneBot.prototype), {
    senderBackend: 'wechat-ui',
    targetsSending: new Set(),
    checkNative: async () => ({ account: 'fixture' }),
    resolveTarget: async () => 'fixture-peer',
    textDeliveries: { key: () => id, get: () => null },
    dispatchDesktop: () => assert.fail('unexpected send'),
  });
  await assert.rejects(
    adapter.send('private', '123', 'fixture', id, null, undefined, true),
    /TEXT_DELIVERY_UNCONFIRMED/,
  );
  const voice = Object.assign(Object.create(VoiceSend.prototype), {
    replies: new Map(),
    load: () => null,
    save: () => assert.fail('unexpected voice admission'),
  });
  const result = await voice.speakReply({
    kind: 'private',
    target: '123',
    text: 'fixture',
    deliveryId: id,
    receiptOnly: true,
  });
  assert.equal(result.status, 'unconfirmed');
  assert.equal(result.fallback, false);
});

test('same-text history cannot confirm a waiting task or a different operation', async t => {
  const f = fixture(t);
  const accountRef = 'b'.repeat(64);
  selectPluginAccount(f.root, accountRef);
  let sends = 0,
    result;
  const adapter = Object.assign(Object.create(WechatOneBot.prototype), {
    directory: f.root,
    account: 'fixture',
    accountRef,
    delivery: {},
    targetsSending: new Set(),
    status: { confirmed_sends: 0 },
    project: f.config,
    reload() {},
    allowed: () => true,
    checkNative: async () => ({ account: 'fixture' }),
    resolveTarget: async () => 'fixture-peer',
    messages: async () => [{ isSend: 1, localId: 1, serverId: '100', fullText: '收到', createTime: Date.now() / 1000 }],
    textDeliveries: new TextDeliveryStore(path.join(f.root, 'state/text-deliveries')),
    dispatchDesktop: async (_route, body) => {
      sends++;
      return (result = {
        deliveryId: body.deliveryId,
        operation: 'text',
        admitted: true,
        pending: true,
        submitted: false,
        confirmed: false,
        state: 'waiting',
      });
    },
    desktopSender: { request: async () => result },
  });
  const send = (query = false) => adapter.send('private', '123', '收到', id, null, undefined, query);
  assert.equal((await send()).pending, true);
  const original = result.deliveryId;
  result = {
    ...result,
    state: 'confirmed',
    confirmed: true,
    pending: false,
    receipt: { source: 'wechat-server-id', serverId: '101', localId: 2 },
  };
  result.deliveryId = 'wrong';
  await assert.rejects(send(true), /TEXT_DELIVERY_UNCONFIRMED/);
  result.deliveryId = original;
  assert.equal((await send(true)).server_id, '101');
  assert.equal((await send()).reused, true);
  assert.equal(sends, 1);
});

for (const lostAcknowledgement of [false, true]) {
  test(
    'a normal retry can recover a saved receipt while readiness is unavailable, lost=' + lostAcknowledgement,
    async t => {
      const f = fixture(t);
      const accountRef = 'b'.repeat(64);
      selectPluginAccount(f.root, accountRef);
      const store = new TextDeliveryStore(path.join(f.root, 'state/text-deliveries'));
      const nativeId = store.key('private', '123', id, 'scheduled notice');
      const calls = [];
      let ready = true;
      const adapter = Object.assign(Object.create(WechatOneBot.prototype), {
        directory: f.root,
        account: 'fixture',
        accountRef,
        project: f.config,
        targetsSending: new Set(),
        status: { confirmed_sends: 0 },
        textDeliveries: store,
        reload() {},
        allowed: () => true,
        async checkNative() {
          calls.push('readiness');
          if (!ready) throw Error('fixture desktop readiness unavailable');
          return { account: 'fixture' };
        },
        async dispatchDesktop(operation, payload) {
          calls.push('admit');
          assert.equal(payload.deliveryId, nativeId);
          if (lostAcknowledgement) throw Error('fixture lost admission acknowledgement');
          return { deliveryId: nativeId, operation, admitted: true, pending: true, state: 'submitted' };
        },
        desktopSender: {
          async request(operation, scope) {
            calls.push(operation);
            assert.equal(operation, 'lookup');
            assert.equal(scope.deliveryId, nativeId);
            assert.equal(scope.accountRef, accountRef);
            assert.equal(scope.observeOnly, true);
            return {
              deliveryId: nativeId,
              operation: 'text',
              admitted: true,
              state: 'confirmed',
              confirmed: true,
              receipt: { source: 'wechat-server-id', serverId: '99', localId: 1 },
            };
          },
        },
      });
      const send = () => adapter.send('private', '123', 'scheduled notice', id);
      assert.equal((await send()).pending, true);
      assert.equal(store.get(nativeId).state, lostAcknowledgement ? 'dispatching' : 'accepted');
      ready = false;
      assert.equal((await send()).server_id, '99');
      assert.equal((await send()).reused, true);
      f.config.wechat.rosterGrants = { [key]: 'replacement-grant' };
      await assert.rejects(send(), /TEXT_DELIVERY_ID_CONFLICT/);
      assert.equal((await adapter.send('private', '123', 'scheduled notice', id, null, undefined, true)).reused, true);
      selectPluginAccount(f.root, 'c'.repeat(64));
      await assert.rejects(send(), /DESKTOP_ACCOUNT_CHANGED/);
      assert.deepEqual(calls, ['readiness', 'admit', 'lookup']);
      assert.equal(adapter.targetsSending.size, 0);
    },
  );
}

test('a saved dispatch resumes after definitive absence, but never after an inconclusive lookup', async t => {
  const f = fixture(t);
  const directory = path.join(f.root, 'state/text-deliveries');
  const accountRef = 'b'.repeat(64);
  const activeAccount = path.join(f.root, 'state/weflow/active-account.json');
  fs.mkdirSync(path.dirname(activeAccount), { recursive: true });
  fs.writeFileSync(activeAccount, JSON.stringify({ id: accountRef }));
  let dispatches = 0,
    nativeJobs = 0,
    result = null,
    ready = true,
    indexAvailable = true;
  const adapter = Object.assign(Object.create(WechatOneBot.prototype), {
    delivery: {},
    targetsSending: new Set(),
    status: { confirmed_sends: 0 },
    project: f.config,
    directory: f.root,
    account: 'fixture',
    accountRef,
    reload() {},
    allowed: () => true,
    async checkNative() {
      if (!ready) throw Error('fixture desktop readiness unavailable');
      return { account: 'fixture' };
    },
    resolveTarget: async () => 'fixture-peer',
    textDeliveries: new TextDeliveryStore(directory),
    desktopSender: {
      request: async (op, scope) => {
        assert.equal(op, 'lookup');
        assert.equal(scope.accountRef, adapter.accountRef);
        if (!indexAvailable) throw Error('temporary failure');
        return result;
      },
    },
    dispatchDesktop: async (operation, body) => {
      dispatches++;
      if (dispatches === 1) throw Error('target lookup interrupted before admission');
      nativeJobs++;
      assert.equal(body.text, 'original');
      result = { deliveryId: body.deliveryId, operation, admitted: true, state: 'waiting', pending: true };
      throw Error('response lost after admission');
    },
  });
  const send = (receiptOnly = false) => adapter.send('private', '123', 'original', id, null, undefined, receiptOnly);
  assert((await send()).pending);
  adapter.textDeliveries = new TextDeliveryStore(directory);
  indexAvailable = false;
  await assert.rejects(send(true), /UNCONFIRMED/);
  await assert.rejects(send(), /UNCONFIRMED/);
  assert.equal(dispatches, 1);
  indexAvailable = true;
  await assert.rejects(adapter.send('private', '123', 'original', id, null, undefined, true, true), /UNCONFIRMED/);
  ready = false;
  await assert.rejects(send(), /fixture desktop readiness unavailable/);
  assert.equal(dispatches, 1);
  ready = true;
  assert((await send(true)).pending);
  assert((await send(true)).pending);
  assert.equal(nativeJobs, 1);
  const admitted = result;
  result = null; // Missing state after a recorded admission is an uncertain outcome.
  await assert.rejects(send(true), /UNCONFIRMED/);
  result = {
    ...admitted,
    state: 'confirmed',
    pending: false,
    confirmed: true,
    receipt: { source: 'wechat-server-id', serverId: '99', localId: 1 },
  };
  assert.equal((await send(true)).server_id, '99');
  assert.equal(nativeJobs, 1);
});
