import { spawnSync } from 'node:child_process';
import { savedIntakeProgress } from './reader-intake-status.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessageBuffer } from '../components/qq-bridge/src/core/message-buffer.js';
import { SocialEngine } from '../components/qq-bridge/src/core/social-engine.js';
import { HistoryStore } from '../packages/dsh-social-bridge-plugin/history-store.mjs';
import { WechatOneBot } from './wechat-onebot.mjs';
import { RealtimeReplies, realtimeReplyId } from './realtime-reply.mjs';
import { WechatOneBotAdapter } from '../components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js';

test('adapter reconnects keep their Reader consumer identity and advance the connection number', () => {
  const adapter = Object.create(WechatOneBot.prototype);
  adapter.advanceIntakeConsumer();
  const first = adapter.readerConsumer;
  adapter.advanceIntakeConsumer();
  const second = adapter.readerConsumer;
  assert.match(first, /^[a-f0-9]{24}00000001$/);
  assert.equal(second, first.slice(0, 24) + '00000002');
});

test('reader event is acknowledged only after durable bridge intake and can replay a failed admission', async () => {
  const adapter = Object.create(WechatOneBot.prototype);
  Object.assign(adapter, {
    claimIntakeRoute: async () => 'dsh',
    ownWxid: 'test-owner',
    activeActions: 0,
    intakePending: new Map(),
    reload() {},
    status: { last_error: '', failed_sends: 0 },
  });
  const bridge = new WechatOneBotAdapter();
  const request = { rawid: 'c'.repeat(64), token: 'd'.repeat(64), version: 1, grant: 'legacy', route: 'dsh' };
  const event = {
    post_type: 'message',
    message_type: 'private',
    message_id: request.rawid,
    user_id: '42',
    self_id: adapter.ownWxid,
    time: Math.floor(Date.now() / 1000),
    message: [{ type: 'text', data: { text: 'fixture' } }],
    wechatagent: {},
  };
  const socket = {
    readyState: WebSocket.OPEN,
    send(raw) {
      bridge.server.emit('event', JSON.parse(raw));
    },
  };
  adapter.socket = socket;
  bridge.server.action = (action, params) => adapter.action({ action, params });
  let calls = 0;
  bridge.acceptPersisted = async () => {
    calls++;
    if (calls === 1) {
      socket.readyState = WebSocket.CLOSED;
      return false;
    }
    return true;
  };
  assert.equal(await adapter.persistIntake({}, event, request), false);
  assert.equal(adapter.intakePending.size, 0);
  socket.readyState = WebSocket.OPEN;
  assert.equal(await adapter.persistIntake({}, event, request), true);
  assert.equal(calls, 2);
});

function realtimeIntake(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-realtime-reconnect-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const accountRef = 'a'.repeat(64);
  const grant = 'fixture-grant';
  const receipt = {
    route: 'realtime',
    rawid: 'b'.repeat(64),
    token: 'c'.repeat(64),
    account: accountRef,
    grant,
  };
  const payload = { type: 1, sessionId: 'peer', talkerId: 'peer', content: 'fixture', readerRole: 'social' };
  const event = { message_type: 'private', wechatagent: {} };
  const forwarded = [];
  const routed = [];
  const adapter = Object.create(WechatOneBot.prototype);
  const socket = {
    readyState: WebSocket.OPEN,
    send(raw) {
      forwarded.push(JSON.parse(raw).wechatagent.readerIntake);
      adapter.intakePending.get(receipt.token).confirmed = true;
    },
  };
  const selected = { id: 'fixture-provider', generation: '1' };
  const generate = t.mock.fn(async () => ({ mode: 'text', text: 'fixture reply', allowed: () => true }));
  const voiceSend = {
    synthesis: { candidates: () => [selected], selected: () => selected, generate },
    pluginGrant: () => undefined,
  };
  Object.assign(adapter, {
    directory,
    socket,
    account: 'selected-account',
    accountRef,
    voiceSend,
    status: {},
    project: {
      wechat: { whitelist: { private: ['peer'], groups: [] }, rosterGrants: { 'wechat:private:peer': grant } },
    },
    intakePending: new Map(),
    reload() {},
    async checkNative() {
      return { account: this.account, accountRef: this.accountRef };
    },
    async claimIntakeRoute(request, route, forward) {
      assert.deepEqual(request, receipt);
      routed.push([route, forward]);
      return route;
    },
  });
  adapter.realtime = new RealtimeReplies(adapter, voiceSend);
  const id = realtimeReplyId(adapter.realtimeInput(payload, event, receipt));
  const record = () => adapter.realtime.load(id);
  const persist = (eventPayload = payload, proof = receipt) => adapter.persistIntake(eventPayload, event, proof);
  return { adapter, socket, payload, receipt, forwarded, routed, generate, record, persist };
}

for (const [offlineReplay, voice] of [
  ['context', false],
  ['reply', false],
  ['context', true],
]) {
  test(
    'a previously classified offline Realtime message starts no new decision, replay=' +
      offlineReplay +
      ', voice=' +
      voice,
    async t => {
      const f = realtimeIntake(t);
      const checkNative = t.mock.method(f.adapter, 'checkNative');
      const replay = {
        ...f.payload,
        offlineReplay,
        ...(voice ? { type: 34, voice: { id: 'e'.repeat(64) } } : {}),
      };
      assert.equal(await f.persist(replay), false);
      assert.deepEqual(f.routed, [['dsh', true]]);
      assert.equal(checkNative.mock.callCount(), 0);
      assert.equal(f.generate.mock.callCount(), 0);
      assert.equal(f.record(), null);

      assert.equal(await f.persist(replay, { ...f.receipt, route: 'dsh' }), true);
      assert.deepEqual(f.forwarded, [{ ...f.receipt, route: 'dsh', offlineReplay, readerRole: 'social' }]);
    },
  );
}

test('a Realtime readiness check that returns after socket replacement cannot start a decision', async t => {
  const f = realtimeIntake(t);
  const entered = Promise.withResolvers();
  const ready = Promise.withResolvers();
  const checkNative = f.adapter.checkNative.bind(f.adapter);
  t.mock.method(f.adapter, 'checkNative', async () => {
    entered.resolve();
    await ready.promise;
    return checkNative();
  });
  const work = f.persist();
  try {
    await Promise.race([entered.promise, work]);
    assert.equal(f.record(), null);
    f.adapter.socket = { ...f.socket };
  } finally {
    ready.resolve();
    await work;
  }

  assert.equal(await work, false);
  assert.equal(f.generate.mock.callCount(), 0);
  assert.equal(f.record(), null);
  assert.deepEqual(f.routed, []);
  assert.equal(await f.persist(), true);
  assert.equal(f.generate.mock.callCount(), 1);
  assert.equal(f.record().stage, 'decided');
});

test('a Realtime decision already started on a live socket is reused by an offline replay', async t => {
  const f = realtimeIntake(t);
  const entered = Promise.withResolvers();
  const finished = Promise.withResolvers();
  t.mock.method(f.adapter.voiceSend.synthesis, 'generate', async (...args) => {
    entered.resolve();
    await finished.promise;
    return f.generate(...args);
  });
  const work = f.persist();
  try {
    await Promise.race([entered.promise, work]);
    assert.equal(f.record().stage, 'deciding');
    f.adapter.socket = { ...f.socket };
  } finally {
    finished.resolve();
    await work;
  }

  const decided = f.record();
  assert.equal(decided.stage, 'decided');
  assert.equal(decided.text, 'fixture reply');
  assert.equal(await f.persist({ ...f.payload, offlineReplay: 'context' }), true);
  assert.equal(f.generate.mock.callCount(), 1);
  assert.deepEqual(f.record(), decided);
  assert.deepEqual(f.routed, []);
  assert.deepEqual(f.forwarded, []);
});

test('a disabled Realtime route forwards unstarted work and only observes an existing send', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-realtime-route-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const account = 'a'.repeat(64),
    grant = 'fixture-grant',
    receipt = { route: 'realtime', rawid: 'b'.repeat(64), token: 'c'.repeat(64), account, grant };
  const payload = { type: 1, sessionId: 'peer', talkerId: 'peer', content: 'fixture' };
  const event = { message_type: 'private', wechatagent: {} };
  const calls = [];
  const adapter = Object.create(WechatOneBot.prototype);
  const socket = {
    readyState: WebSocket.OPEN,
    send(raw) {
      assert.equal(JSON.parse(raw).wechatagent.readerIntake.rawid, receipt.rawid);
      calls.push('dsh');
      adapter.intakePending.get(receipt.token).confirmed = true;
    },
  };
  Object.assign(adapter, {
    directory,
    socket,
    account: 'selected-account',
    accountRef: account,
    status: {},
    project: {
      wechat: { whitelist: { private: ['peer'], groups: [] }, rosterGrants: { 'wechat:private:peer': grant } },
    },
    intakePending: new Map(),
    reload() {},
    checkNative() {
      assert.fail('Pure routing and a read-only receipt need no new Realtime request');
    },
    voiceSend: { synthesis: { candidates: () => [] }, load: () => null },
    textDeliveries: { key: (_kind, _target, id) => id, get: () => undefined },
    claimIntakeRoute: async (_receipt, route, forward) => {
      assert.equal(forward, true);
      calls.push(route + '-route');
      return route;
    },
    send: async (
      _kind,
      target,
      text,
      deliveryId,
      _proactive,
      _quote,
      receiptOnly,
      observeOnly,
      _plugin,
      expectedGrant,
    ) => {
      assert.equal(target, 'peer');
      assert.equal(text, 'same previously submitted text');
      assert.match(deliveryId, /^[a-f0-9]{64}$/);
      assert.deepEqual([receiptOnly, observeOnly, expectedGrant], [true, true, grant]);
      calls.push('lookup');
      return { delivered: 'database-confirmed' };
    },
  });
  adapter.realtime = new RealtimeReplies(adapter, adapter.voiceSend);
  assert.equal(await adapter.persistIntake(payload, event, receipt), false);
  assert.equal(await adapter.persistIntake(payload, event, { ...receipt, route: 'dsh' }), true);
  assert.deepEqual(calls, ['dsh-route', 'dsh']);

  const submitted = { ...receipt, rawid: 'd'.repeat(64) };
  const input = adapter.realtimeInput(payload, event, submitted);
  const id = realtimeReplyId(input);
  adapter.realtime.save({
    ...input,
    id,
    version: 1,
    stage: 'decided',
    mode: 'text',
    account: adapter.account,
    text: 'same previously submitted text',
  });
  // Simulate losing the send response before Realtime can save textStatus.
  adapter.textDeliveries.get = () => ({ state: 'dispatching' });
  assert.equal(await adapter.persistIntake(payload, event, submitted), true);
  assert.deepEqual(calls, ['dsh-route', 'dsh']);
  adapter.realtime.tick();
  await adapter.realtime.close();
  assert.equal(adapter.realtime.load(id).observeOnly, true);
  adapter.realtime.tick();
  await adapter.realtime.close();
  assert.equal(adapter.realtime.load(id).textStatus, 'confirmed');
  assert.deepEqual(calls, ['dsh-route', 'dsh', 'lookup']);
});

test('a failed queue commit cannot issue a history receipt, and restart backfills the complete message', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-commit-'));
  const history = new HistoryStore(root);
  t.after(() => {
    history.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(root, 'buffer.json');
  const key = 'wechat:private:42';
  const message = {
    platform: 'wechat',
    kind: 'private',
    conversation_id: '42',
    sender_id: '42',
    message_id: 'b'.repeat(64),
    text: 'a'.repeat(5000),
  };
  const buffer = new MessageBuffer(file, { archive: history });
  const rename = fs.renameSync;
  const failure = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === file) throw Error('interrupted');
    return rename(from, to);
  });
  assert.throws(() => buffer.append(message), /interrupted/);
  assert.equal(buffer.findIncoming(message), null);
  assert.equal(history.hasIncoming(key, message), false);
  failure.mock.restore();

  const archival = t.mock.method(history, 'append', () => {
    throw Error('archive offline');
  });
  assert.throws(() => buffer.append(message), /archive offline/);
  archival.mock.restore();
  const restarted = new MessageBuffer(file, { archive: history });
  assert.equal(restarted.unread(key).length, 1);
  assert.equal(history.rows(key)[0].text, message.text);
  assert.equal(restarted.confirmBuffered(message), true);
  assert.equal(history.rows(key).length, 1);
});

for (const restart of [false, true]) {
  test(
    'an answered input survives archive failure and buffer pressure, restart=' + restart,
    { timeout: 5000 },
    async t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-unarchived-input-'));
      const history = new HistoryStore(root);
      const file = path.join(root, 'buffer.json');
      const options = { archive: history, maxPerChat: 10 };
      const key = 'wechat:private:42';
      const message = {
        platform: 'wechat',
        kind: 'private',
        conversation_id: '42',
        sender_id: '42',
        self_id: '99',
        message_id: 'c'.repeat(64),
        text: 'fixture incoming request',
        timestamp: Date.now() / 1000,
      };
      let buffer = new MessageBuffer(file, options);
      let decisions = 0;
      let sends = 0;
      const make = () =>
        new SocialEngine({
          buffer,
          batchMs: 1,
          decide: async () => {
            decisions++;
            return 'RESPOND: fixture response';
          },
          send: async () => {
            sends++;
            return { delivered: 'database-confirmed' };
          },
        });
      let engine = make();
      t.after(() => {
        engine.stop();
        history.close();
        fs.rmSync(root, { recursive: true, force: true });
      });
      const append = history.append.bind(history);
      const outage = t.mock.method(history, 'append', (chat, row, options) => {
        if (!row.outgoing && row.message_id === message.message_id) throw Error('fixture archive unavailable');
        return append(chat, row, options);
      });
      const intake = () => {
        if (history.hasIncoming(key, message) || buffer.confirmBuffered(message)) return true;
        engine.receive(message, { deferArchive: true });
        return buffer.confirmBuffered(message);
      };

      assert.throws(intake, /fixture archive unavailable/);
      const firstId = buffer.findIncoming(message).id;
      while (sends < 1 || engine.running.has(key)) await new Promise(resolve => setTimeout(resolve, 5));
      const addPressure = offset => {
        for (let n = 0; n < 20; n++)
          buffer.append(
            { ...message, message_id: (offset + n).toString(16).padStart(64, '0'), text: 'other context' },
            { skipReason: 'context_only' },
          );
      };
      addPressure(10);
      assert.equal(history.hasIncoming(key, message), false);
      assert.equal(buffer.findIncoming(message)?.id, firstId);

      outage.mock.restore();
      if (restart) {
        engine.stop();
        buffer = new MessageBuffer(file, options);
        engine = make();
      }
      assert.equal(intake(), true);
      assert.equal(history.hasIncoming(key, message), true);
      assert.equal(buffer.unread(key).length, 0);
      assert.deepEqual([decisions, sends], [1, 1]);

      addPressure(40);
      assert.equal(buffer.findIncoming(message), null);
      assert.equal(history.hasIncoming(key, message), true);
      assert.equal(buffer.chats.get(key).length, buffer.maxPerChat);
    },
  );
}

test('an unarchived transcript revision is retried without a Reader reoffer', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-unarchived-transcript-'));
  const history = new HistoryStore(root);
  t.after(() => {
    history.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const buffer = new MessageBuffer(path.join(root, 'buffer.json'), { archive: history, maxPerChat: 10 });
  const key = 'wechat:private:42';
  const message = {
    platform: 'wechat',
    kind: 'private',
    conversation_id: '42',
    sender_id: '42',
    message_id: 'a'.repeat(64),
    text: 'raw voice message',
  };
  const row = buffer.append(message);
  assert.equal(history.hasIncoming(key, message), true);
  const outage = t.mock.method(history, 'append', () => {
    throw Error('fixture archive unavailable');
  });
  try {
    assert.throws(
      () => buffer.updateVoice(key, row, { text: 'completed transcript' }, { archive: true }),
      /fixture archive unavailable/,
    );
  } finally {
    outage.mock.restore();
  }
  buffer.markProcessed(key, row.id);
  for (let n = 0; n < 20; n++)
    buffer.append(
      { ...message, message_id: (n + 1).toString(16).padStart(64, '0'), text: 'other history' },
      { skipReason: 'context_only' },
    );
  assert.equal(buffer.findIncoming(message)?.text, 'completed transcript');
  assert.equal(archiveText(), 'raw voice message');
  assert.equal(await buffer.retryPendingArchives(), 0);
  assert.equal(archiveText(), 'completed transcript');
  function archiveText() {
    return history.rows(key).find(item => item.message_id === message.message_id)?.text;
  }
});

test('history can trim the recent buffer without losing acknowledged live work', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-buffer-'));
  const history = new HistoryStore(root);
  t.after(() => {
    history.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(root, 'buffer.json');
  const options = { archive: history, maxPerChat: 10 };
  const key = 'wechat:private:42';
  const message = {
    platform: 'wechat',
    kind: 'private',
    conversation_id: '42',
    sender_id: '42',
    message_id: 'a'.repeat(64),
    text: 'live request',
  };
  const buffer = new MessageBuffer(file, options);
  const live = buffer.append(message);
  assert.equal(buffer.confirmBuffered(message), true);
  for (let index = 0; index < 12; index++) {
    buffer.append(
      { ...message, message_id: (index + 1).toString(16).padStart(64, '0'), readerReplay: 'context', text: 'history' },
      { skipReason: 'context_only' },
    );
  }

  assert.equal(history.hasIncoming(key, message), true);
  assert.deepEqual(
    buffer.unread(key).map(row => row.id),
    [live.id],
  );
  const restarted = new MessageBuffer(file, options);
  assert.deepEqual(
    restarted.unread(key).map(row => row.id),
    [live.id],
  );
  assert.equal(restarted.recent(key).length, 10);
  restarted.markProcessed(key, live.id);
  assert.deepEqual(new MessageBuffer(file, options).unread(key), []);
});

test('stopped Reader reports pending counts and scan frontiers only for the current roster grants', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-progress-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = 'a'.repeat(64),
    target = 'fixture-peer',
    key = 'wechat:private:' + target;
  const program = [
    'import sys',
    'from reader_intake import ReaderIntake',
    'j=ReaderIntake(sys.argv[1],sys.argv[2])',
    "j.scan('fixture-peer','first',100,100)",
    "j.scan('fixture-peer','first',4000,4000)",
    "j.capture(dict(sessionId='fixture-peer',rawid='b'*64),'first')",
    "print(j.progress(lambda chat,grant: 'included')[0]['pending'])",
  ].join('\n');
  const result = spawnSync(process.env.WECHATAGENT_TEST_PYTHON || 'python', ['-B', '-c', program, root, scope], {
    cwd: import.meta.dirname,
    windowsHide: true,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '1');
  const wechat = {
    whitelist: { private: [target], groups: [] },
    rosterGrants: { [key]: 'first' },
  };
  assert.deepEqual(savedIntakeProgress(root, scope, wechat), [
    { key, scannedThrough: 100, catchUpThrough: 3999, pending: 1 },
  ]);
  wechat.rosterGrants[key] = 'new';
  assert.deepEqual(savedIntakeProgress(root, scope, wechat), []);
  assert.equal(savedIntakeProgress(root, 'c'.repeat(64), wechat), null);
});

test('a slow voice admission leaves another chat able to receive and acknowledge text', { timeout: 5000 }, async () => {
  const slow = Promise.withResolvers(),
    fast = Promise.withResolvers();
  const first = '1'.repeat(64),
    second = '2'.repeat(64);
  const adapter = Object.create(WechatOneBot.prototype);
  const payload = token => ({
    rawid: token,
    sessionId: token === first ? 'voice-chat' : 'text-chat',
    readerIntake: { version: 1, token, rawid: token, route: 'dsh' },
  });
  const acked = new Set();
  Object.assign(adapter, {
    socket: { readyState: WebSocket.OPEN },
    readerConsumer: 'a'.repeat(32),
    status: { received: 0 },
    api: {},
    incoming: row => row,
    reader: async route => {
      const busy = new URL(route, 'http://localhost').searchParams.getAll('busy');
      const token = [first, second].find(id => !busy.includes(id) && !acked.has(id));
      return { event: token ? payload(token) : null };
    },
    persistIntake: async row => {
      if (row.rawid === first) await slow.promise;
      return true;
    },
    json: async (_base, _route, options) => {
      const { token } = JSON.parse(options.body);
      acked.add(token);
      if (token === second) fast.resolve();
      if (acked.size === 2) adapter.stopped = true;
    },
  });
  const reading = adapter.receiveReaderInbox();
  try {
    await fast.promise;
    assert.deepEqual([...acked], [second]);
  } finally {
    slow.resolve();
  }
  await reading;
  assert.equal(adapter.status.received, 2);
});

test('Realtime backlog stays in Reader while another chat receives through DSH', { timeout: 5000 }, async () => {
  const slow = Promise.withResolvers(),
    fast = Promise.withResolvers();
  const events = Array.from({ length: 10 }, (_, index) => {
    const id = String(index).repeat(64);
    return {
      intendedRoute: index === 9 ? 'dsh' : 'realtime',
      rawid: id,
      readerIntake: { version: 1, token: id, rawid: id },
    };
  });
  const started = [];
  const adapter = Object.assign(Object.create(WechatOneBot.prototype), {
    socket: { readyState: WebSocket.OPEN },
    readerConsumer: 'a'.repeat(32),
    status: {},
    incoming: row => row,
    claimIntakeRoute: async receipt => {
      const row = events.find(event => event.rawid === receipt.rawid);
      return (row.readerIntake.route = row.intendedRoute);
    },
    reader: async url => {
      const query = new URL(url, 'http://localhost').searchParams;
      const busy = query.getAll('busy'),
        excluded = query.getAll('excludeRoute');
      return {
        event: events.find(row => !busy.includes(row.rawid) && !excluded.includes(row.readerIntake.route)) ?? null,
      };
    },
    deliverIntake: async (row, _event, receipt) => {
      started.push(receipt.route);
      if (row.intendedRoute === 'realtime') await slow.promise;
      else {
        adapter.stopped = true;
        fast.resolve();
      }
    },
  });
  const reading = adapter.receiveReaderInbox();
  try {
    await fast.promise;
    assert.deepEqual(started, ['realtime', 'dsh']);
    assert.ok(events.every(row => row.readerIntake.route === row.intendedRoute));
  } finally {
    slow.resolve();
  }
  await reading;
});

test(
  'reader status follows intake connectivity through a polling failure and recovery',
  { timeout: 6000 },
  async () => {
    const adapter = Object.create(WechatOneBot.prototype);
    const observed = [];
    Object.assign(adapter, {
      socket: { readyState: WebSocket.OPEN },
      readerConsumer: 'fixture-consumer',
      status: { reader_connected: false, last_error: '' },
      reader: async () => {
        observed.push(adapter.status.reader_connected);
        if (observed.length === 2) throw Error('Reader unavailable');
        if (observed.length === 3) return {};
        if (observed.length === 5) adapter.stopped = true;
        return { event: null };
      },
    });
    await adapter.receiveReaderInbox();
    assert.deepEqual(observed, [false, true, false, false, true]);
    assert.equal(adapter.status.last_error, '');
  },
);
