import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { readerEvent } from './onebot-events.mjs';
import { normalizeOneBotEvent } from '../components/qq-bridge/src/onebot/normalize.js';
import { executeOnebotAction } from './onebot-actions.mjs';
import { WechatOneBotAdapter } from '../components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js';
import { WechatOneBot } from './wechat-onebot.mjs';
import { ReverseOneBotServer } from '../components/qq-bridge/src/onebot/reverse-ws-server.js';

test('the desktop adapter authenticates every local OneBot connection including reconnects', async t => {
  const token = 'fixture-onebot-token';
  const original = process.env.SOCIAL_ONEBOT_TOKEN;
  process.env.SOCIAL_ONEBOT_TOKEN = token;
  t.after(() => {
    if (original === undefined) delete process.env.SOCIAL_ONEBOT_TOKEN;
    else process.env.SOCIAL_ONEBOT_TOKEN = original;
  });
  const server = new ReverseOneBotServer({ port: 0, token });
  await server.start();
  const adapter = Object.assign(Object.create(WechatOneBot.prototype), {
    api: { onebot_ws_url: 'ws://127.0.0.1:' + server.server.address().port + '/ws' },
    ownWxid: 'fixture-account',
    status: {},
    stopped: false,
  });
  const nextLifecycle = () => once(server, 'event', { signal: AbortSignal.timeout(5000) }).then(([event]) => event);
  const first = nextLifecycle();
  const worker = adapter.connectOneBot();
  try {
    assert.equal((await first).self_id, adapter.ownWxid);
    const originalConsumer = adapter.readerConsumer;
    const second = nextLifecycle();
    server.socket.destroy();
    assert.equal((await second).self_id, adapter.ownWxid);
    assert.notEqual(adapter.readerConsumer, originalConsumer);
    assert.equal(adapter.status.ob_connected, true);
  } finally {
    adapter.stopped = true;
    adapter.socket?.close();
    await server.stop();
    await worker;
  }
});

test('a new OneBot transport waits for the current account identity', () => {
  const bridge = new WechatOneBotAdapter();
  bridge.server.emit('open');
  bridge.server.emit('event', { post_type: 'meta_event', self_id: 'first-account' });
  assert.equal(bridge.selfId, 'first-account');
  bridge.server.emit('close');
  assert.equal(bridge.stats.connected, false);
  bridge.server.emit('open');
  assert.equal(bridge.stats.connected, true);
  assert.equal(Boolean(bridge.selfId), false);
  bridge.server.emit('event', { post_type: 'meta_event', self_id: 'second-account' });
  assert.equal(bridge.selfId, 'second-account');
});

test('OneBot lists preserve Reader identities and filter each nonempty list by chat authorization', async () => {
  const sessions = [
    { username: 'fixture-peer', displayName: 'Friend' },
    ...Array.from({ length: 500 }, (_, i) => ({ username: 'excluded-peer-' + i })),
    { username: 'fixture-room@chatroom', displayName: 'Group' },
    { username: 'excluded-peer', displayName: 'Excluded' },
    { username: 'excluded-room@chatroom', displayName: 'Excluded group' },
  ];
  const adapter = {
    activeActions: 0,
    status: {},
    reload() {},
    allowed: (kind, id) => id === (kind === 'private' ? 'fixture-peer' : 'fixture-room@chatroom'),
    reader: async route => {
      const url = new URL(route, 'http://127.0.0.1');
      assert.equal(url.pathname, '/api/v1/sessions');
      return { sessions: sessions.slice(0, Number(url.searchParams.get('limit'))) };
    },
  };
  for (const [action, expected] of [
    ['get_friend_list', [{ user_id: 'fixture-peer', nickname: 'Friend', remark: 'Friend' }]],
    ['get_group_list', [{ group_id: 'fixture-room@chatroom', group_name: 'Group' }]],
  ]) {
    const response = await executeOnebotAction(adapter, { action, echo: action });
    assert.deepEqual(response, { status: 'ok', retcode: 0, data: expected, echo: action });
    assert.equal(adapter.activeActions, 0);
  }
});

for (const blockedPool of ['receipts', 'admissions']) {
  test('OneBot keeps other work and intake acknowledgements available while ' + blockedPool + ' are full', async () => {
    const release = Promise.withResolvers();
    const token = 'fixture-intake-token',
      rawid = 'fixture-raw-id',
      self = 'wxid_fixture_self';
    const pending = { token, rawid, confirmed: false };
    let held = 0;
    const wait = async receipt => {
      if (receipt === (blockedPool === 'receipts')) {
        held++;
        await release.promise;
      }
      return { pending: true };
    };
    const adapter = {
      activeActions: 0,
      activeReceiptActions: 0,
      status: { failed_sends: 0 },
      ownWxid: self,
      intakePending: new Map([[token, pending]]),
      reload() {},
      allowed: () => true,
      send: (_kind, _target, _text, _id, _proactive, _quote, receiptOnly) => wait(!!receiptOnly),
      sendSticker: (_kind, _target, _id, options) => wait(options.receiptOnly && !options.abandon),
      voiceSend: { speakReply: options => wait(options.receiptOnly) },
    };
    const text = index => ({
      action: 'send_private_msg',
      params: { user_id: 'new-chat-' + index, message: [{ type: 'text', data: { text: 'hello' } }] },
    });
    const receipt = index => {
      const target = 'receipt-chat-' + index;
      const wechatagent_delivery_id = index.toString(16).padStart(64, '0');
      if (index % 3 === 0)
        return {
          action: 'get_text_delivery',
          params: {
            kind: 'private',
            target,
            wechatagent_delivery_id,
            message: [{ type: 'text', data: { text: 'hello' } }],
          },
        };
      if (index % 3 === 1)
        return {
          action: 'send_private_msg',
          params: {
            user_id: target,
            wechatagent_delivery_id,
            wechatagent_receipt_only: true,
            message: [{ type: 'wechat_sticker', data: { id: 'fixture-sticker' } }],
          },
        };
      return {
        action: 'get_voice_delivery',
        params: { kind: 'private', target, wechatagent_delivery_id, text: 'hello' },
      };
    };
    const ack = (id = rawid) =>
      executeOnebotAction(adapter, { action: 'ack_wechatagent_intake', params: { token, rawid: id, self_id: self } });
    const blocked = blockedPool === 'receipts' ? receipt : text;
    const other = blockedPool === 'receipts' ? text : receipt;
    const requests = Array.from({ length: 8 }, (_, index) => executeOnebotAction(adapter, blocked(index)));
    try {
      assert.equal(held, 8);
      const overflow = executeOnebotAction(adapter, blocked(8));
      requests.push(overflow);
      const limit = await Promise.race([overflow, new Promise(resolve => setImmediate(() => resolve(null)))]);
      assert.equal(limit?.message, 'SENDER_BUSY');
      assert.equal((await executeOnebotAction(adapter, other(9))).status, 'ok');
      assert.equal((await ack('different-rawid')).message, 'INTAKE_RECEIPT_MISMATCH');
      assert.equal(pending.confirmed, false);
      assert.equal((await ack()).data.accepted, true);
      assert.equal(pending.confirmed, true);
      assert.equal(held, 8);
    } finally {
      release.resolve();
      await Promise.all(requests);
    }
    assert.equal(adapter.activeActions, 0);
    assert.equal(adapter.activeReceiptActions, 0);
  });
}

test('OneBot limits retries of missing desktop jobs without blocking native receipts', async () => {
  const readiness = Promise.withResolvers();
  const attempts = new Map(),
    receipts = new Map(),
    submissions = [];
  const account = 'fixture',
    accountRef = 'a'.repeat(64);
  let probes = 0;
  const nativeJob = (deliveryId, operation) => ({
    admitted: true,
    deliveryId,
    operation,
    state: 'queued',
    pending: true,
  });
  const adapter = Object.assign(Object.create(WechatOneBot.prototype), {
    accountRef,
    targetsSending: new Set(),
    status: { failed_sends: 0, confirmed_sends: 0 },
    project: { wechat: {} },
    reload() {},
    allowed: () => true,
    receiptAccount: () => ({ account, accountRef }),
    async checkNative() {
      probes++;
      await readiness.promise;
      return { account };
    },
    textDeliveries: {
      key: (_kind, _target, id) => id,
      get: id => attempts.get(id),
      put: attempt => attempts.set(attempt.deliveryId, attempt),
    },
    desktopSender: {
      async request(operation, { deliveryId, observeOnly }) {
        assert.equal(operation, 'lookup');
        assert.equal(observeOnly, true);
        return receipts.get(deliveryId) ?? null;
      },
    },
    async dispatchDesktop(operation, { deliveryId }) {
      submissions.push(deliveryId);
      return nativeJob(deliveryId, operation);
    },
  });
  function query(index, operation = 'text', quoteEventId) {
    const deliveryId = index.toString(16).padStart(64, '0'),
      target = 'fixture-peer-' + index,
      reference = 'b'.repeat(64);
    const media = operation !== 'text';
    attempts.set(deliveryId, {
      deliveryId,
      account,
      accountRef,
      grant: 'legacy',
      target,
      text: media ? '[STICKER:' + reference + ']' : 'hello',
      operation,
      quoteEventId,
      command: {},
      state: 'dispatching',
    });
    const message = media
      ? [{ type: 'wechat_sticker', data: { id: reference } }]
      : [
          ...(quoteEventId ? [{ type: 'reply', data: { id: quoteEventId } }] : []),
          { type: 'text', data: { text: 'hello' } },
        ];
    return {
      action: media ? 'send_private_msg' : 'get_text_delivery',
      params: {
        ...(media ? { user_id: target, wechatagent_receipt_only: true } : { kind: 'private', target }),
        wechatagent_delivery_id: deliveryId,
        message,
      },
    };
  }
  const run = request => executeOnebotAction(adapter, request);
  const byNextTurn = promise => Promise.race([promise, new Promise(resolve => setImmediate(resolve, null))]);
  const pending = Array.from({ length: 8 }, (_, index) =>
    query(index, ['text', 'image', 'sticker'][index % 3], index === 3 ? 'c'.repeat(64) : undefined),
  );
  const requests = pending.map(run);
  const overflow = query(8, 'image');
  const overflowId = overflow.params.wechatagent_delivery_id;
  let results;
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(probes, 8);
    const receipt = query(9);
    const nativeId = receipt.params.wechatagent_delivery_id;
    receipts.set(nativeId, {
      ...nativeJob(nativeId, 'text'),
      state: 'confirmed',
      confirmed: true,
      receipt: { source: 'wechat-server-id', serverId: '1234', localId: 42 },
    });
    const recovered = await byNextTurn(run(receipt));
    assert.equal(recovered?.status, 'ok', recovered?.message);
    assert.equal(recovered.data.server_id, '1234');
    assert.equal(adapter.activeActions, 8);
    assert.equal(adapter.activeReceiptActions, 0);
    assert.equal((await run({ action: 'get_status' })).message, 'SENDER_BUSY');
    assert.equal((await byNextTurn(run(overflow)))?.message, 'SENDER_BUSY');
    assert.equal(attempts.get(overflowId).state, 'dispatching');
    const observe = query(10);
    observe.params.wechatagent_observe_only = true;
    assert.equal((await byNextTurn(run(observe)))?.message, 'TEXT_DELIVERY_UNCONFIRMED');
    assert.equal(probes, 8);
    assert.deepEqual(submissions, []);
  } finally {
    readiness.resolve();
    results = await Promise.all(requests);
  }
  assert.ok(results.every(result => result.data.admitted === true));
  assert.deepEqual(
    submissions,
    pending.map(request => request.params.wechatagent_delivery_id),
  );
  assert.equal((await run(overflow)).data.admitted, true);
  assert.equal(submissions.at(-1), overflowId);
  assert.equal(adapter.activeActions, 0);
  assert.equal(adapter.activeReceiptActions, 0);
  assert.equal(adapter.targetsSending.size, 0);
});

test('the bridge returns pending for an ordinary send and keeps the same receipt identity', async () => {
  const bridge = new WechatOneBotAdapter();
  let deliveryId;
  bridge.server.action = async (action, params) => {
    if (action === 'send_private_msg') {
      deliveryId = params.wechatagent_delivery_id;
      assert.match(deliveryId, /^[a-f0-9]{64}$/u);
      return { data: { pending: true, delivery_id: deliveryId, admitted: true } };
    }
    assert.equal(action, 'get_text_delivery');
    assert.equal(params.wechatagent_delivery_id, deliveryId);
    return { data: { receipt: 'wechat-server-id' } };
  };
  const pending = await bridge.sendPrivateMessage('fixture-peer', 'hello');
  assert.equal(pending.pending, true);
  assert.equal(pending.admitted, true);
  assert.equal(pending.deliveryId, deliveryId);
  const result = await bridge.sendText({
    kind: 'private',
    target: 'fixture-peer',
    text: 'hello',
    deliveryId,
    receiptOnly: true,
  });
  assert.equal(result.confirmed, true);
  assert.equal(result.deliveryId, deliveryId);
});

test('quote source failure is classified before any desktop admission', async () => {
  let status = 503;
  const adapter = Object.assign(Object.create(WechatOneBot.prototype), {
    activeActions: 0,
    status: { failed_sends: 0 },
    api: { reader_base_url: 'http://127.0.0.1', reader_token: 'fixture' },
    fetch: async () => new Response(null, { status }),
    reload() {},
    allowed: () => true,
    checkNative: async () => ({ account: 'fixture' }),
    targetsSending: new Set(),
    project: { wechat: {} },
    delivery: {},
    textDeliveries: {
      key: () => 'fixture',
      get: () => null,
      put: () => assert.fail('quote lookup cannot create an input intent'),
    },
    dispatchDesktop: () => assert.fail('quote lookup cannot submit plain text'),
  });
  const action = 'send_private_msg';
  const params = {
    user_id: 'peer',
    wechatagent_delivery_id: 'a'.repeat(64),
    message: [
      { type: 'reply', data: { id: 'b'.repeat(64) } },
      { type: 'text', data: { text: 'fixture reply' } },
    ],
  };
  const temporary = await executeOnebotAction(adapter, { action, params });
  assert.equal(temporary.message, 'SENDER_BUSY');
  assert.equal(temporary.data.reason, 'INPUT_QUOTE_LOOKUP_UNAVAILABLE');
  status = 409;
  const unavailable = await executeOnebotAction(adapter, { action, params });
  assert.equal(unavailable.message, 'NATIVE_SEND_REJECTED');
  assert.deepEqual(unavailable.data, {
    rejected: true,
    attempted: false,
    reason: 'INPUT_QUOTE_SOURCE_UNVERIFIED',
  });
});

test('the native refusal reason survives the original OneBot send and receipt lookup', async () => {
  let attempt,
    submissions = 0;
  const adapter = Object.assign(Object.create(WechatOneBot.prototype), {
    activeActions: 0,
    status: { failed_sends: 0 },
    reload() {},
    allowed: () => true,
    checkNative: async () => ({ account: 'fixture' }),
    receiptAccount: () => ({ account: 'fixture' }),
    targetsSending: new Set(),
    project: { wechat: {} },
    delivery: {},
    textDeliveries: {
      key: () => 'fixture',
      get: () => attempt,
      put: value => {
        attempt = value;
      },
    },
    dispatchDesktop: async (operation, { deliveryId }) => {
      submissions++;
      return {
        admitted: true,
        operation,
        deliveryId,
        state: 'cancelled',
        reason: 'DESKTOP_INPUT_EXPIRED',
        submission: 'not-started',
        inputStarted: false,
      };
    },
  });
  const params = {
    user_id: 'fixture-peer',
    wechatagent_delivery_id: 'a'.repeat(64),
    message: [{ type: 'text', data: { text: 'fixture reply' } }],
  };
  const sent = await executeOnebotAction(adapter, { action: 'send_private_msg', params });
  const lookedUp = await executeOnebotAction(adapter, {
    action: 'get_text_delivery',
    params: { ...params, kind: 'private', target: params.user_id },
  });
  assert.equal(sent.message, 'NATIVE_SEND_REJECTED');
  assert.deepEqual(sent.data, { rejected: true, attempted: false, reason: 'DESKTOP_INPUT_EXPIRED' });
  assert.deepEqual(lookedUp, sent);
  assert.equal(submissions, 1);
});

test('native identities round trip through Reader, bridge and actions without changing case or suffixes', async () => {
  const self = 'wxid_Owner_ab12',
    peer = 'wxid_Peer_Ab12',
    room = '84210@chatroom';
  const allowed = (kind, id) => id === (kind === 'private' ? peer : room);
  const input = {
    event: 'message.new',
    rawid: 'message-81',
    talkerId: peer,
    type: 1,
    content: 'hello',
    sourceName: '同名',
  };
  const make = extra => readerEvent({ ...input, ...extra }, { ownWxid: self, allowed });
  for (const [kind, target] of [
    ['private', peer],
    ['group', room],
  ]) {
    const event = make({ sessionId: target, mentionsSelf: true });
    const row = normalizeOneBotEvent('wechat', 'desktop', event);
    assert.equal(row.self_id, self);
    assert.equal(row.conversation_id, target);
    assert.equal(row.sender_id, peer);
    assert.equal(row.sender_wxid, peer);
    assert.equal(row.message_id, input.rawid);
    if (kind === 'group') assert.equal(row.mentionTarget, 'self');
    const sent = [],
      adapter = {
        activeActions: 0,
        status: {},
        reload() {},
        allowed,
        send(...args) {
          sent.push(args);
          return { confirmed: true };
        },
        checkNative: async () => ({ selfId: self }),
        project: { account: { nicknames: ['机器人'] } },
      };
    const params = {
      [kind === 'group' ? 'group_id' : 'user_id']: target,
      message: [{ type: 'text', data: { text: 'hello' } }],
    };
    assert.equal((await executeOnebotAction(adapter, { action: 'send_' + kind + '_msg', params })).status, 'ok');
    assert.deepEqual(sent[0].slice(0, 3), [kind, target, 'hello']);
    assert.equal((await executeOnebotAction(adapter, { action: 'get_login_info' })).data.user_id, self);
    assert.equal(
      (await executeOnebotAction(adapter, { action: 'get_version_info' })).data.protocol_version,
      'wechatagent-ws-v1',
    );
  }
  assert.equal(make({ sessionId: peer.toLowerCase() }), null);
  assert.equal(make({ sessionId: peer, talkerId: 'wxid_someone_else' }), null);
  assert.equal(make({ sessionId: 84210 }), null);
  const context = normalizeOneBotEvent(
    'wechat',
    'desktop',
    make({ sessionId: peer, talkerId: 'wechat-system', contextOnly: true }),
  );
  assert.equal(context.conversation_id, peer);
  assert.equal(context.sender_id, 'wechat-system');
  assert.equal(context.sender_wxid, undefined);
  assert.equal(context.contextOnly, true);
});
