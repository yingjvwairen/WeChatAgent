import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { MessageBuffer, replyDeliveryParts } from '../components/qq-bridge/src/core/message-buffer.js';
import { SocialEngine } from '../components/qq-bridge/src/core/social-engine.js';
import { VoiceIngress } from '../components/qq-bridge/src/core/voice-ingress.js';
import { ProactiveEngine } from '../components/qq-bridge/src/core/proactive-engine.js';
import { PROACTIVE_DEFAULTS } from '../components/qq-bridge/src/core/proactive-policy.js';
import { DshConnectionGuard } from '../components/qq-bridge/src/core/dsh-connection.js';
import { DshPluginClient } from '../components/qq-bridge/src/dsh/plugin-client.js';
import { AssistantTasks } from '../packages/dsh-social-bridge-plugin/assistant-tasks.mjs';

const key = 'wechat:private:123',
  sticker = 'a'.repeat(64);
const incoming = (id, time, kind = 'private') => ({
  platform: 'wechat',
  kind,
  conversation_id: '123',
  sender_id: 'fixture',
  sender_wxid: 'fixture-admin',
  sender_name: 'Fixture',
  self_id: 'self',
  message_id: id,
  text: id,
  timestamp: time / 1000,
});
const until = async predicate => {
  for (let i = 0; i < 600; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('Reconnect fixture timed out');
};
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-reconnect-')),
    file = path.join(root, 'messages.json'),
    engines = [],
    guards = [],
    sent = [],
    calls = [],
    logs = [];
  let now = 2000000000000,
    health = { ready: true, instanceId: 'instance-a', startedAt: now - 10000 };
  const make = (buffer = new MessageBuffer(file)) => {
    const guard = new DshConnectionGuard({
      buffer,
      now: () => now,
      probe: async () => (typeof health === 'function' ? health() : health),
      log: line => logs.push(line),
    });
    const engine = new SocialEngine({
      buffer,
      connection: guard,
      batchMs: 1,
      privateMinIntervalMs: 0,
      minIntervalMs: 0,
      maxPerMinute: 100,
      maxPerTenMinutes: 1000,
      assistantAccess: () => true,
      workModeFor: () => (options.assistant ? 'assistant' : 'social'),
      stickerPolicyFor: () => ({ enabled: false, labelCache: false }),
      decide: async (...args) => {
        calls.push(args);
        return options.decide ? options.decide(...args) : 'RESPOND: fixture response';
      },
      inspectReceipt: options.inspectReceipt,
      deliveryRetry: { receiptDelayMs: 10 },
      send: async (...args) => {
        sent.push(args);
        return options.send ? options.send(...args) : { delivered: 'database-confirmed' };
      },
      log: line => logs.push(line),
    });
    engines.push(engine);
    guards.push(guard);
    return { buffer, guard, engine };
  };
  t.after(() => {
    for (const e of engines) e.stop();
    for (const g of guards) g.stop();
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    ...make(),
    make,
    root,
    file,
    sent,
    calls,
    logs,
    get now() {
      return now;
    },
    advance: ms => (now += ms),
    setHealth: value => (health = value),
  };
}
test('legacy pending input is archived on initial readiness and never replayed', async t => {
  const f = fixture(t);
  f.buffer.append(incoming('old', f.now - 3600000));
  await f.guard.check();
  f.engine.replay(key);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.calls.length, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.buffer.unread(key).length, 0);
  assert.equal(f.buffer.recent(key)[0].reply_skip_reason, 'dsh_reconnected');
});
test('offline input is retained in history but a reconnect replies only to new input', async t => {
  const f = fixture(t);
  await f.guard.check();
  f.setHealth({ ready: false });
  await f.guard.check({ force: true });
  for (let i = 0; i < 60; i++) f.engine.receive(incoming('offline-' + i, f.now));
  assert.equal(f.buffer.unread(key).length, 0);
  assert.equal(f.buffer.recent(key, 300).length, 60);
  f.advance(60000);
  f.setHealth({ ready: true, instanceId: 'instance-b', startedAt: f.now });
  await f.guard.check({ force: true });
  f.engine.replay(key);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.calls.length, 0);
  f.engine.receive(incoming('fresh', f.now + 1000));
  await until(() => f.sent.length === 1 && !f.engine.running.size);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0][1], /fresh/);
  assert.match(f.calls[0][1], /offline-59/);
  assert.doesNotMatch(f.calls[0][1], /offline-0/);
  assert.equal(f.calls[0][2].dshInstanceId, 'instance-b');
});
test('queued offline inputs and their no-replay boundary survive a bridge restart', async t => {
  const f = fixture(t);
  await f.guard.check();
  f.setHealth({ ready: false });
  await f.guard.check({ force: true });
  f.engine.receive(incoming('offline', f.now));
  f.engine.stop();
  f.guard.stop();
  f.advance(30000);
  f.setHealth({ ready: true, instanceId: 'instance-b', startedAt: f.now });
  const restored = f.make();
  await restored.guard.check();
  restored.engine.replay(key);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.sent.length, 0);
  assert.equal(restored.buffer.unread(key).length, 0);
  assert(restored.buffer.recent(key)[0].processed);
});
test('an instance change is detected even when the offline polling gap was missed', async t => {
  const f = fixture(t);
  await f.guard.check();
  f.buffer.append(incoming('old-queued', f.now));
  f.advance(5000);
  f.setHealth({ ready: true, instanceId: 'instance-b', startedAt: f.now });
  await f.guard.check({ force: true });
  assert.equal(f.buffer.unread(key).length, 0);
  f.engine.receive(incoming('new', f.now + 1000));
  await until(() => f.sent.length === 1);
  assert.equal(f.calls.length, 1);
});
test('a late reader event from before reconnect cannot create a new model turn', async t => {
  const f = fixture(t);
  await f.guard.check();
  f.setHealth({ ready: false });
  await f.guard.check({ force: true });
  f.advance(5000);
  f.setHealth({ ready: true, instanceId: 'instance-b', startedAt: f.now });
  await f.guard.check({ force: true });
  f.engine.receive(incoming('late-offline-event', f.now - 10000));
  f.engine.replay(key);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.calls.length, 0);
  assert.equal(f.buffer.recent(key)[0].reply_skip_reason, 'before_dsh_reconnect');
});
test('a temporary outage of the same instance still advances the late-input boundary', async t => {
  const f = fixture(t);
  await f.guard.check();
  const startedAt = f.now - 10000;
  f.setHealth({ ready: false });
  await f.guard.check({ force: true });
  f.advance(5000);
  f.setHealth({ ready: true, instanceId: 'instance-a', startedAt });
  await f.guard.check({ force: true });
  f.engine.receive(incoming('late outage input', f.now - 3000));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.calls.length, 0);
  assert.equal(f.buffer.unread(key).length, 0);
});
test('a restart in the same timestamp second retires a saved old-instance batch', async t => {
  let finish;
  const f = fixture(t, { decide: () => new Promise(resolve => (finish = resolve)) });
  await f.guard.check();
  f.engine.receive(incoming('same-second', f.now));
  await until(() => finish);
  assert.equal(f.buffer.pendingRequests.size, 1);
  f.advance(100);
  f.setHealth({ ready: true, instanceId: 'instance-b', startedAt: f.now });
  await f.guard.check({ force: true });
  assert.equal(f.buffer.unread(key).length, 0);
  assert.equal(f.buffer.pendingRequests.size, 0);
  finish('RESPOND: old');
  await until(() => !f.engine.running.size);
  assert.equal(f.sent.length, 0);
});
test('an old model result arriving after a reconnect is discarded before sending', async t => {
  let finish;
  const f = fixture(t, { decide: () => new Promise(resolve => (finish = resolve)) });
  await f.guard.check();
  f.engine.receive(incoming('original', f.now + 1000));
  await until(() => finish);
  f.setHealth({ ready: false });
  await f.guard.check({ force: true });
  f.advance(10000);
  f.setHealth({ ready: true, instanceId: 'instance-b', startedAt: f.now });
  await f.guard.check({ force: true });
  finish('RESPOND: stale result');
  await until(() => !f.engine.running.size);
  assert.equal(f.sent.length, 0);
  assert.equal(f.buffer.pendingRequests.size, 0);
});
test('an unsent old draft cannot be delivered after recovery and cannot block fresh input', async t => {
  const f = fixture(t);
  await f.guard.check();
  const row = f.buffer.append(incoming('draft', f.now));
  const result = { decision: 'RESPOND', text: 'old draft' },
    deliveryId = 'c'.repeat(64);
  const item = {
    result,
    throughId: row.id,
    message: { ...incoming('draft', f.now), work_mode: 'social' },
    deliveryId,
    parts: replyDeliveryParts(result, deliveryId),
    connectionEpoch: f.guard.epoch,
    sending: true,
  };
  f.buffer.rememberReply(key, item);
  f.engine.decisions.set(key, item);
  f.setHealth({ ready: false });
  await f.guard.check({ force: true });
  assert.equal(item.parts[0].state, 'cancelled');
  assert.equal(f.buffer.pendingReplies.size, 0);
  f.advance(5000);
  f.setHealth({ ready: true, instanceId: 'instance-b', startedAt: f.now });
  await f.guard.check({ force: true });
  f.engine.receive(incoming('fresh', f.now + 1000));
  await until(() => f.sent.length === 1);
  assert.notEqual(f.sent[0][1], 'old draft');
});
test('queued old media is retired without a native submission on a connection boundary', async t => {
  const f = fixture(t);
  await f.guard.check();
  let submissions = 0;
  f.engine.sendSticker = async () => {
    submissions++;
  };
  const deliveryId = 'd'.repeat(64),
    result = { decision: 'STICKER', stickerId: sticker },
    item = { result, deliveryId, message: incoming('media', f.now) };
  f.engine.media.enqueue(key, item, replyDeliveryParts(result, deliveryId)[0]);
  f.setHealth({ ready: false });
  await f.guard.check({ force: true });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(submissions, 0);
  assert.equal(f.buffer.mediaReplies.size, 0);
});
test('submitted old media releases only its receipt reservation during disconnect', async t => {
  const f = fixture(t);
  await f.guard.check();
  let lookups = 0,
    submissions = 0;
  f.engine.sendSticker = async (_message, _id, options) => {
    if (options.receiptOnly && options.abandon) lookups++;
    else submissions++;
    return { released: true };
  };
  const deliveryId = 'e'.repeat(64),
    message = incoming('submitted media', f.now);
  f.buffer.mediaReplies.set(deliveryId, {
    key,
    message,
    part: { stickerId: sticker, deliveryId, state: 'submitted' },
    createdAt: Date.now(),
    expiresAt: Date.now() + 30000,
  });
  f.buffer.saveMedia();
  f.setHealth({ ready: false });
  await f.guard.check({ force: true });
  await until(() => lookups === 1);
  assert.equal(submissions, 0);
  assert.equal(f.buffer.mediaReplies.size, 0);
});
test('offline drafts are cancelled while uncertain submitted text stays recorded as uncertain', async t => {
  const f = fixture(t);
  await f.guard.check();
  const row = f.buffer.append(incoming('draft', f.now));
  const result = { decision: 'RESPOND', text: 'old draft' },
    deliveryId = 'b'.repeat(64);
  const item = {
    result,
    throughId: row.id,
    message: { ...incoming('draft', f.now), work_mode: 'social' },
    deliveryId,
    parts: replyDeliveryParts(result, deliveryId),
    connectionEpoch: f.guard.epoch,
    sending: true,
  };
  item.parts[0].state = 'sending';
  f.buffer.rememberReply(key, item);
  f.engine.decisions.set(key, item);
  f.setHealth({ ready: false });
  await f.guard.check({ force: true });
  assert.equal(f.buffer.pendingReplies.size, 0);
  assert.equal(f.buffer.recent(key).find(row => row.outgoing).delivery_status, 'unconfirmed');
  assert.equal(f.sent.length, 0);
});
test('fresh input after a recovered instance does not wait for the old model response', async t => {
  const stale = Promise.withResolvers();
  const f = fixture(t, {
    decide: (_key, prompt) => (prompt.includes('fresh') ? 'RESPOND: fresh result' : stale.promise),
  });
  try {
    await f.guard.check();
    f.engine.receive(incoming('original', f.now + 1000));
    await until(() => f.calls.length === 1);
    f.setHealth({ ready: false });
    await f.guard.check({ force: true });
    f.advance(5000);
    f.setHealth({ ready: true, instanceId: 'instance-b', startedAt: f.now });
    await f.guard.check({ force: true });
    f.engine.receive(incoming('fresh', f.now + 1000));

    await until(() => f.sent.length === 1 && !f.engine.running.size);
    assert.equal(f.sent[0][1], 'fresh result');
    assert.match(f.calls.at(-1)[1], /original/);
    assert.equal(f.buffer.pendingRequests.size, 0);
    assert.equal(f.buffer.findIncoming(incoming('original', f.now)).reply_skip_reason, 'dsh_offline');
    stale.resolve('RESPOND: stale');
    await stale.promise;
    assert.equal(f.sent.length, 1);
  } finally {
    f.engine.stop();
    stale.resolve('RESPOND: stale');
  }
});
test('a cancelled proactive decision releases the chat for a live reply after reconnect', async t => {
  const stale = Promise.withResolvers();
  let started = false;
  let now = Date.parse('2026-11-26T02:00:00Z');
  const f = fixture(t);
  const proactive = new ProactiveEngine({
    stateFile: path.join(f.root, 'proactive.json'),
    buffer: f.buffer,
    social: f.engine,
    settingsFor: () => ({
      whitelist: { groups: [], private: ['123'] },
      proactive: {
        ...PROACTIVE_DEFAULTS,
        enabled: true,
        intervalMinutes: 30,
        idleMinutes: 5,
        jitterMinutes: 0,
        chats: { [key]: true },
      },
    }),
    personaFor: () => ({ persona: 'Fixture', personaName: 'Fixture' }),
    decide: async () => {
      started = true;
      return stale.promise;
    },
    send: () => assert.fail('a stale proactive reply must not be sent'),
    selfIdFor: () => 'self',
    isReady: () => f.guard.ready,
    now: () => now,
    random: () => 0,
  });
  try {
    await f.guard.check();
    await proactive.tick();
    now += 30 * 60000;
    const waiting = proactive.tick();
    await until(() => started);
    f.setHealth({ ready: false });
    await f.guard.check({ force: true });
    f.advance(5000);
    f.setHealth({ ready: true, instanceId: 'instance-b', startedAt: f.now });
    await f.guard.check({ force: true });
    f.engine.receive(incoming('fresh', f.now + 1000));

    await until(() => f.sent.length === 1);
    await waiting;
    assert.equal(f.sent[0][0].message_id, 'fresh');
    assert.equal(proactive.state.chats[key].job, null);
  } finally {
    stale.resolve('RESPOND: stale');
  }
});

test('a busy DSH session retries the same unadmitted batch once the agent is available', async t => {
  let attempts = 0;
  const f = fixture(t, {
    decide: async () => {
      if (++attempts === 1) throw Object.assign(Error('session_busy'), { code: 'DSH_SESSION_BUSY', admitted: false });
      return 'RESPOND: retry finished';
    },
  });
  await f.guard.check();
  f.engine.receive(incoming('fresh input', f.now + 1000));
  await until(() => f.sent.length === 1 && !f.engine.running.size);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0][2].batchId, f.calls[1][2].batchId);
  assert.equal(f.sent[0][1], 'retry finished');
  assert.equal(f.buffer.pendingRequests.size, 0);
});

test('a disconnected transcription releases the voice worker for new messages', async t => {
  const stale = Promise.withResolvers();
  let oldSignal;
  const recognized = [];
  const ingress = new VoiceIngress({
    recognize: async (target, { signal }) => {
      recognized.push(target.message_id);
      if (target.message_id === 'old voice') {
        oldSignal = signal;
        return stale.promise;
      }
      return { ok: true, text: 'new transcript' };
    },
  });
  t.after(() => {
    ingress.stop();
    stale.resolve({ ok: true, text: 'old transcript' });
  });
  const f = fixture(t);
  f.engine.prepareVoiceRows = (...args) => ingress.prepareRows(...args);
  await f.guard.check();
  const voice = { id: 'c'.repeat(64) };
  f.engine.receive({ ...incoming('old voice', f.now + 1000), voice });
  await until(() => oldSignal);
  f.setHealth({ ready: false });
  await f.guard.check({ force: true });
  f.advance(5000);
  f.setHealth({ ready: true, instanceId: 'instance-b', startedAt: f.now });
  await f.guard.check({ force: true });
  f.engine.receive({ ...incoming('new voice', f.now + 1000), voice });

  await until(() => f.sent.length === 1 && !f.engine.running.size);
  assert.equal(oldSignal.aborted, true);
  assert.deepEqual(recognized, ['old voice', 'new voice']);
  assert.match(f.calls[0][1], /new transcript/);
  assert.doesNotMatch(f.calls[0][1], /old transcript/);
  assert.equal(f.buffer.findIncoming(incoming('old voice', f.now)).reply_skip_reason, 'dsh_offline');
  assert.equal(ingress.active, 0);
});

test('ordinary model errors do not mark a healthy plugin offline or erase queued input', async t => {
  const f = fixture(t, {
    decide: async () => {
      throw Error('fixture model error');
    },
  });
  await f.guard.check();
  f.engine.receive(incoming('retryable', f.now + 1000));
  await until(() => f.calls.length === 1 && !f.engine.running.size);
  assert.equal(f.guard.ready, true);
  assert.equal(f.buffer.unread(key).length, 1);
});
test('an assistant message received offline is archived for review and never automatically submitted', async t => {
  const f = fixture(t, { assistant: true });
  f.setHealth({ ready: false });
  await f.guard.check();
  f.engine.receive(incoming('new task', f.now));
  f.advance(5000);
  f.setHealth({ ready: true, instanceId: 'instance-b', startedAt: f.now });
  await f.guard.check({ force: true });
  f.engine.replay(key);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.calls.length, 0);
  assert(f.buffer.recent(key)[0].reply_review_required);
});
test('corrupt persisted connection boundaries fail without overwriting the saved queue', t => {
  const f = fixture(t);
  fs.writeFileSync(
    f.file,
    JSON.stringify({ version: 1, chats: {}, dshConnection: { version: 1, ready: true, epoch: -1 } }),
  );
  const original = fs.readFileSync(f.file);
  assert.throws(() => new MessageBuffer(f.file), /invalid DSH connection/);
  assert.deepEqual(fs.readFileSync(f.file), original);
});
test('pending and active assistant tasks become review-required after a host restart', async t => {
  const f = fixture(t),
    file = path.join(f.root, 'tasks.json');
  let executions = 0;
  const jobs = new AssistantTasks({
    file,
    concurrency: 1,
    allowed: () => true,
    execute: async () => {
      executions++;
      return new Promise(() => {});
    },
  });
  t.after(() => jobs.close());
  const request = batch => ({ conversationKey: key, assistantSender: 'fixture-admin', batchId: batch.repeat(64) });
  const a = jobs.submit(request('a')),
    b = jobs.submit(request('b'));
  await until(() => jobs.get(a.id).state === 'running');
  const restored = new AssistantTasks({
    file,
    allowed: () => true,
    execute: async () => {
      executions++;
    },
  });
  t.after(() => restored.close());
  restored.pump();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(executions, 1);
  assert.equal(restored.get(a.id).state, 'interrupted');
  assert.equal(restored.get(b.id).state, 'interrupted');
  const continued = restored.submit({ ...request('c'), assistantParentId: b.id });
  await until(() => restored.get(continued.id).state === 'completed');
  assert.equal(executions, 2);
  assert.equal(restored.get(b.id).state, 'interrupted');
});
test('health readiness requires the authenticated bridge contract and exposes the instance identity', async t => {
  let health = {
    ok: true,
    project: 'WeChatAgent',
    contextMode: 'native-session-v1',
    instanceId: 'instance-one',
    instanceStartedAt: 123,
  };
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/health');
    assert.equal(req.headers.authorization, 'Bearer fixture');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(health));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new DshPluginClient({ url: 'http://127.0.0.1:' + server.address().port, token: 'fixture' });
  assert.deepEqual(await client.connectionHealth(), { ready: true, instanceId: 'instance-one', startedAt: 123 });
  assert.equal((await client.connectionHealth({ projectRoot: 'fixture-project' })).ready, false);
  assert.equal((await client.connectionHealth({ accountScope: 'fixture-account' })).ready, false);
  health = { ...health, ok: false };
  assert.equal((await client.connectionHealth()).ready, false);
  health = { ...health, ok: true, project: 'another' };
  assert.equal((await client.connectionHealth()).ready, false);
});

test('cancelling a model wait closes the local HTTP request', async t => {
  let received = false,
    closed = false;
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/followup');
    req.resume();
    if (received) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'agent_unavailable', detail: 'session_busy' }));
    }
    received = true;
    res.once('close', () => (closed = true));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const controller = new AbortController();
  const client = new DshPluginClient({ url: 'http://127.0.0.1:' + server.address().port, token: 'fixture' });
  const pending = assert.rejects(client.followup(key, 'fixture', {}, { signal: controller.signal }), {
    code: 'DSH_CONNECTION_CHANGED',
  });
  await until(() => received);
  controller.abort(Object.assign(Error('DSH_CONNECTION_CHANGED'), { code: 'DSH_CONNECTION_CHANGED' }));
  await pending;
  await until(() => closed);
  await assert.rejects(client.followup(key, 'fixture'), { code: 'DSH_SESSION_BUSY', admitted: false });
});

test('an interrupted desktop reply survives restart as an observation of its original part only', async t => {
  let status = 'pending';
  const observed = [];
  const f = fixture(t, {
    decide: async () => 'RESPOND: first text\n\nsecond text',
    send: async () => ({ pending: true }),
    inspectReceipt: async (_, part) => {
      observed.push(part.deliveryId);
      return { status };
    },
  });
  await f.guard.check();
  f.engine.receive(incoming('receipt fixture', f.now + 1000));
  await until(() => f.buffer.pendingReplies.get(key)?.parts[0]?.state === 'submitted');
  const id = f.sent[0][2].deliveryId;
  f.setHealth({ ready: false });
  await f.guard.check({ force: true });
  assert.deepEqual(
    f.buffer.pendingReplies.get(key).parts.map(part => part.state),
    ['submitted', 'cancelled'],
  );
  f.engine.stop();
  f.guard.stop();
  const restored = f.make();
  await restored.guard.check();
  status = 'confirmed';
  restored.engine.replay(key);
  await until(() =>
    restored.buffer.recent(key).some(row => row.delivery_id === id && row.delivery_status === 'confirmed'),
  );
  assert.equal(restored.buffer.pendingReplies.size, 0);
  assert.equal(f.sent.length, 1);
  assert.equal(f.calls.length, 1);
  assert.ok(observed.length);
  assert.ok(observed.every(value => value === id));
});

test('DSH recovery can answer new input while a cancelled reply awaits its original receipt', async t => {
  const receipt = Promise.withResolvers();
  const observed = [];
  const f = fixture(t, {
    send: async target =>
      target.message_id === 'before-disconnect'
        ? { pending: true, admitted: true }
        : { delivered: 'database-confirmed' },
    inspectReceipt: async (_, part) => {
      observed.push(part.deliveryId);
      return receipt.promise;
    },
  });
  try {
    await f.guard.check();
    f.engine.receive(incoming('before-disconnect', f.now + 1000));
    await until(() => f.buffer.pendingReplies.get(key)?.parts[0].state === 'submitted' && !f.engine.running.has(key));
    const id = f.sent[0][2].deliveryId;
    f.setHealth({ ready: false });
    assert.equal(await f.guard.check({ force: true }), false);
    await until(() => observed.length === 1);
    f.advance(10000);
    f.setHealth({ ready: true, instanceId: 'instance-b', startedAt: f.now });
    assert.equal(await f.guard.check({ force: true }), true);
    f.engine.receive(incoming('after-reconnect', f.now + 1000));

    await until(() => f.sent.length === 2 && !f.engine.running.has(key));
    assert.deepEqual(
      f.sent.map(([target]) => target.message_id),
      ['before-disconnect', 'after-reconnect'],
    );
    assert.equal(f.calls.length, 2);
    assert.equal(f.buffer.findIncoming(incoming('before-disconnect', f.now)).reply_skip_reason, 'dsh_offline');
    assert.equal(f.buffer.replyReceipts.has(id), true);
    assert.equal(f.buffer.findReplyPart(key, id), undefined);
    receipt.resolve({ status: 'confirmed' });
    await until(() => f.buffer.findReplyPart(key, id)?.delivery_status === 'confirmed');
    assert.deepEqual(observed, [id]);
    assert.equal(f.buffer.pendingReplies.size, 0);
    assert.equal(f.buffer.replyReceipts.size, 0);
  } finally {
    f.engine.stop();
    receipt.resolve({ status: 'pending' });
  }
});

test('new media can be sent while the retired image receipts are outstanding', async t => {
  const receipt = Promise.withResolvers();
  const oldIds = ['b', 'c', 'd'].map(value => value.repeat(64));
  const newId = 'e'.repeat(64);
  const observed = [];
  const sent = [];
  const f = fixture(t, {
    inspectReceipt: async (_, part) => {
      observed.push(part.deliveryId);
      if (observed.length === 1) return receipt.promise;
      return { status: 'confirmed', mediaType: 'wechat-image' };
    },
  });
  const media = f.engine.media;
  media.policy = async () => ({ enabled: true });
  f.engine.sendSticker = async (_target, _asset, options) => {
    sent.push(options.deliveryId);
    return { delivered: 'database-confirmed', data: { media_type: 'wechat-image' } };
  };
  const enqueue = deliveryId => {
    const result = { decision: 'STICKER', stickerId: sticker };
    media.enqueue(key, { message: incoming(deliveryId, f.now) }, replyDeliveryParts(result, deliveryId)[0]);
  };
  try {
    await f.guard.check();
    for (const id of oldIds) {
      enqueue(id);
      f.buffer.mediaReplies.get(id).part.state = 'submitted';
    }
    f.setHealth({ ready: false });
    assert.equal(await f.guard.check({ force: true }), false);
    await until(() => observed.length === 1);
    f.advance(10000);
    f.setHealth({ ready: true, instanceId: 'instance-b', startedAt: f.now });
    assert.equal(await f.guard.check({ force: true }), true);

    enqueue(newId);
    await until(() => f.buffer.findReplyPart(key, newId)?.delivery_status === 'confirmed');
    assert.deepEqual(sent, [newId]);
    assert.deepEqual([...new MessageBuffer(f.file).mediaReplies.keys()].toSorted(), oldIds);
    receipt.resolve({ status: 'pending' });
    await until(() => f.buffer.mediaReplies.size === 0);
    assert.deepEqual(observed, [...oldIds, oldIds[0]]);
    for (const id of oldIds) assert.equal(f.buffer.findReplyPart(key, id)?.delivery_status, 'confirmed');
    assert.deepEqual(sent, [newId]);
  } finally {
    f.engine.stop();
    receipt.resolve({ status: 'pending' });
  }
});

test('a failed withdrawal is retried even if DSH recovers before the next probe', async t => {
  const f = fixture(t);
  await f.guard.check();
  const epoch = f.guard.epoch;
  let calls = 0;
  f.guard.onBoundary = () => {
    if (++calls === 1) throw Error('fixture write contention');
  };
  f.setHealth({ ready: false });
  assert.equal(await f.guard.check({ force: true }), false);
  assert.equal(f.guard.epoch, epoch);
  f.setHealth({ ready: true });
  assert.equal(await f.guard.check({ force: true }), true);
  assert.equal(f.guard.epoch, epoch + 1);
  assert.equal(calls, 2);
});

test('DSH restart preserves an in-flight image receipt and discards its queued successor', async t => {
  let observed = 0;
  const f = fixture(t, {
    inspectReceipt: async (_target, part) => {
      assert.equal(part.stickerId, sticker);
      observed++;
      return { status: 'confirmed', mediaType: 'wechat-sticker' };
    },
  });
  await f.guard.check();
  const delivered = 'c'.repeat(64),
    queued = 'd'.repeat(64),
    msg = incoming('image receipt', f.now);
  const entry = (id, state) => ({
    key,
    message: msg,
    part: { stickerId: sticker, deliveryId: id, state },
    createdAt: Date.now(),
    expiresAt: Date.now() + 30000,
  });
  f.buffer.mediaReplies.set(delivered, entry(delivered, 'submitted'));
  f.buffer.mediaReplies.set(queued, entry(queued, 'queued'));
  f.buffer.saveMedia();
  f.setHealth({ ready: false });
  await f.guard.check({ force: true });
  f.engine.stop();
  f.guard.stop();
  const restored = f.make();
  await restored.guard.check();
  await until(() =>
    restored.buffer.recent(key).some(row => row.delivery_id === delivered && row.delivery_status === 'confirmed'),
  );
  assert.equal(restored.buffer.mediaReplies.size, 0);
  assert.ok(observed >= 1);
  assert.equal(f.sent.length, 0);
});
