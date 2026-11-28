import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseSocialDecision,
  resolveSocialDecision,
  cleanReplyProtocol,
  hasReplyProtocolControl,
} from '../components/qq-bridge/src/core/decision-format.js';
import { MessageBuffer, replyDeliveryParts } from '../components/qq-bridge/src/core/message-buffer.js';
import { SocialEngine } from '../components/qq-bridge/src/core/social-engine.js';
import { ProactiveEngine } from '../components/qq-bridge/src/core/proactive-engine.js';
import { PROACTIVE_DEFAULTS } from '../components/qq-bridge/src/core/proactive-policy.js';
import { textSegments } from './onebot-actions.mjs';
import { deliverDesktopMessage } from './desktop-message-delivery.mjs';
import { TextDeliveryStore } from './text-delivery-store.mjs';
import { ReplyDeliveryControls } from '../packages/dsh-social-bridge-plugin/reply-delivery-controls.mjs';

test('long model replies fit the desktop transport on grapheme boundaries', () => {
  const body = '测'.repeat(6000);
  const split = parseSocialDecision('RESPOND: ' + body, {}, { maxChars: 12000 });
  assert.equal(split.textParts.join(''), body);
  for (const text of split.textParts) assert.equal(textSegments([{ type: 'text', data: { text } }]), text);

  const id = 'a'.repeat(64);
  for (const [reply, options] of [
    [body, { maxChars: 12000, maxTextParts: 1 }],
    ['[QUOTE:Q1] ' + body, { maxChars: 12000, quoteRefs: { Q1: id } }],
    ['a'.repeat(1199) + '👩‍💻', {}],
  ]) {
    const result = parseSocialDecision('RESPOND: ' + reply, {}, options);
    assert.equal(result.decision, 'RESPOND');
    assert.equal(result.textParts, undefined);
    assert(result.text.endsWith('…'));
    assert.equal(textSegments([{ type: 'text', data: { text: result.text } }]), result.text);
  }
});
const key = 'wechat:private:123';
const message = (id = 'fixture', kind = 'private') => ({
  platform: 'wechat',
  kind,
  conversation_id: kind === 'group' ? '123@chatroom' : '123',
  sender_id: '456',
  self_id: '99',
  message_id: id,
  text: '你好',
  direct_mention: true,
  timestamp: Date.now() / 1000,
});
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-protocol-'));
  t.after(() => {
    assert(dir.startsWith(os.tmpdir() + path.sep));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { dir, buffer: new MessageBuffer(path.join(dir, 'messages.json')) };
}
async function until(check) {
  for (let i = 0; i < 250; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('protocol fixture timeout');
}

for (const shape of ['submitted text', 'claimed text', 'in-flight text', 'observing voice']) {
  test('withdrawn replies reconcile just their stored submissions, ' + shape, async t => {
    const f = fixture(t);
    const config = path.join(f.dir, 'config/wechatagent.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const wechat = { whitelist: { groups: [], private: ['123'] } };
    const save = () => fs.writeFileSync(config, JSON.stringify({ wechat }));
    save();
    const controls = new ReplyDeliveryControls(f.dir, 'legacy');
    const voice = shape === 'observing voice';
    const inFlight = shape === 'in-flight text';
    const text = '原回复';
    const next = '未发送的后续分段';
    const result = voice
      ? { decision: 'RESPOND', mode: 'voice', text }
      : { decision: 'RESPOND', text: text + '\n\n' + next, textParts: [text, next] };
    const id = 'a'.repeat(64);
    const parts = replyDeliveryParts(result, id);
    assert.equal(controls.register(key, 'legacy', parts), true);
    if (!inFlight) assert.equal(controls.claim(key, 'legacy', id), 'send');
    if (!inFlight && shape !== 'claimed text') parts[0].state = 'submitted';
    const incoming = message('grant-withdrawn');
    const throughId = f.buffer.append(incoming).id;
    f.buffer.rememberReply(key, {
      message: incoming,
      rosterGrant: 'legacy',
      throughId,
      result,
      parts,
      deliveryId: id,
      sending: true,
      ...(voice ? { offlineCancelled: true } : {}),
    });

    const withdraw = () => {
      wechat.rosterGrants = { [key]: 'replacement-grant' };
      save();
    };
    if (!inFlight) withdraw();
    const seen = [];
    const sent = [];
    const buffer = new MessageBuffer(f.buffer.file);
    const engine = new SocialEngine({
      buffer,
      deliveryControls: controls,
      batchMs: 1,
      deliveryRetry: { receiptDelayMs: 5 },
      decide: () => assert.fail('withdrawn work must not start a new turn'),
      send: async (_target, _text, options) => {
        assert.equal(inFlight, true, 'withdrawn work must not send text');
        sent.push(options.deliveryId);
        withdraw();
        return { pending: true, admitted: true };
      },
      sendVoice: () => assert.fail('withdrawn work must not send voice'),
      inspectReceipt: async (target, part) => {
        seen.push([target.readerGrant, part.deliveryId]);
        return { status: seen.length === 1 ? 'pending' : 'confirmed' };
      },
    });
    t.after(() => engine.stop());
    engine.replay(key);
    await until(() => buffer.pendingReplies.size === 0 && buffer.replyReceipts.size === 0 && !engine.running.has(key));
    assert.deepEqual(seen, [
      ['legacy', id],
      ['legacy', id],
    ]);
    assert.deepEqual(sent, inFlight ? [id] : []);
    const delivered = buffer.findReplyPart(key, id);
    assert.equal(delivered.delivery_status, 'confirmed');
    if (!voice) {
      assert.equal(buffer.findReplyPart(key, parts[1].deliveryId), undefined);
      assert.equal(controls.inputWithdrawn(key, 'legacy', parts[1].deliveryId), true);
    }
    assert.deepEqual(controls.list(key).replies, []);
  });
}

test('a retired receipt cannot hold a fresh reply under the replacement grant', async t => {
  const f = fixture(t);
  const config = path.join(f.dir, 'config/wechatagent.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const wechat = { whitelist: { private: ['123'], groups: [] } };
  const save = () => fs.writeFileSync(config, JSON.stringify({ wechat }));
  save();
  const controls = new ReplyDeliveryControls(f.dir, 'legacy');
  const id = 'a'.repeat(64);
  const result = { decision: 'RESPOND', text: '旧回复' };
  const parts = replyDeliveryParts(result, id);
  assert.equal(controls.register(key, 'legacy', parts), true);
  assert.equal(controls.claim(key, 'legacy', id), 'send');
  parts[0].state = 'submitted';
  const older = { ...message('old-for-receipt'), readerGrant: 'legacy' };
  f.buffer.rememberReply(key, {
    message: older,
    throughId: f.buffer.append(older).id,
    deliveryId: id,
    result,
    parts,
    sending: true,
  });
  wechat.rosterGrants = { [key]: 'replacement-grant' };
  save();
  const gate = Promise.withResolvers();
  const lookedUp = [];
  const sent = [];
  const make = (buffer, inspect) => {
    const engine = new SocialEngine({
      buffer,
      deliveryControls: controls,
      inspectReceipt: async (target, part) => {
        lookedUp.push([target.readerGrant, part.deliveryId]);
        return inspect();
      },
      batchMs: 1,
      minIntervalMs: 0,
      privateMinIntervalMs: 0,
      deliveryRetry: { receiptDelayMs: 5 },
      decide: async () => 'RESPOND: 新授权的回复',
      send: async (target, text) => {
        sent.push([target.readerGrant, text]);
        return { delivered: 'database-confirmed' };
      },
    });
    t.after(() => engine.stop());
    return engine;
  };
  const engine = make(f.buffer, () => gate.promise);
  try {
    engine.replay(key);
    await until(() => lookedUp.length === 1);
    engine.receive({ ...message('new-with-new-grant'), readerGrant: 'replacement-grant' });
    await until(() => sent.length === 1 && !engine.running.has(key));
    assert.deepEqual(sent, [['replacement-grant', '新授权的回复']]);
    assert.equal(f.buffer.findReplyPart(key, id), undefined);
    assert.equal(f.buffer.pendingReplies.size, 0);
    assert.equal(f.buffer.replyReceipts.size, 1);
  } finally {
    engine.stop();
    gate.resolve({ status: 'pending' });
  }

  const reopened = new MessageBuffer(f.buffer.file);
  reopened.append({ ...message('new-after-restart'), readerGrant: 'replacement-grant' });
  const restarted = make(reopened, () => ({ status: 'confirmed', sentAt: Date.now() }));
  await until(() => reopened.findReplyPart(key, id)?.delivery_status === 'confirmed');
  assert.deepEqual(lookedUp, [
    ['legacy', id],
    ['legacy', id],
  ]);
  assert.equal(reopened.recent(key, 1)[0].delivery_id, id);
  restarted.replay(key);
  await until(() => sent.length === 2 && !restarted.running.has(key));
  assert.deepEqual(sent, [
    ['replacement-grant', '新授权的回复'],
    ['replacement-grant', '新授权的回复'],
  ]);
  assert.equal(reopened.pendingReplies.size, 0);
  assert.equal(reopened.replyReceipts.size, 0);
});

test('stopping split text lets the next message proceed while the submitted part is checked', async t => {
  const { buffer } = fixture(t);
  const receipt = Promise.withResolvers();
  const observed = [];
  const sent = [];
  const sentAt = Math.floor(Date.now() / 1000) * 1000;
  const order = id =>
    String(sentAt / 1000).padStart(20, '0') + '-' + String(id).padStart(20, '0') + '-' + 'b'.repeat(64);
  const engine = new SocialEngine({
    buffer,
    batchMs: 1,
    privateMinIntervalMs: 0,
    deliveryRetry: { receiptDelayMs: 5 },
    decide: async (_key, prompt) => (prompt.includes('问题一') ? 'RESPOND: 第一段\n\n第二段' : 'RESPOND: 新回复'),
    send: async (target, text, options) => {
      sent.push([target.message_id, text, options.deliveryId]);
      return text === '第一段'
        ? { pending: true, admitted: true }
        : { delivered: 'database-confirmed', sentAt, readerOrder: order(30) };
    },
    inspectReceipt: async (_, part) => {
      observed.push(part.deliveryId);
      return receipt.promise;
    },
  });
  try {
    engine.receive({ ...message('before-stop'), text: '问题一' });
    await until(() => buffer.pendingReplies.get(key)?.parts[0].state === 'submitted' && !engine.running.has(key));
    const id = sent[0][2];
    engine.receive({ ...message('stop-split'), text: '停止分段' });
    await until(() => observed.length === 1);
    engine.receive({ ...message('after-stop'), text: '问题二' });

    await until(() => sent.some(([messageId]) => messageId === 'after-stop') && !engine.running.has(key));
    assert.deepEqual(
      sent.map(([messageId]) => messageId),
      ['before-stop', 'stop-split', 'after-stop'],
    );
    assert.equal(sent[2][1], '新回复');
    assert.equal(buffer.replyReceipts.has(id), true);
    assert.equal(buffer.findReplyPart(key, id), undefined);
    const latestSend = engine.lastReplyAt.get(key);
    receipt.resolve({ status: 'confirmed', sentAt, readerOrder: order(10) });
    await until(() => buffer.findReplyPart(key, id)?.delivery_status === 'confirmed');
    assert.equal(buffer.findReplyPart(key, id).timestamp, sentAt / 1000);
    assert.equal(buffer.findReplyPart(key, id).readerOrder, order(10));
    assert.equal(buffer.recent(key).findLast(row => row.outgoing).text, '新回复');
    assert.equal(engine.lastReplyAt.get(key), latestSend);
    assert.deepEqual(engine.sentAt.get(key), [sentAt, latestSend]);
    assert.deepEqual(observed, [id]);
    assert.equal(buffer.pendingReplies.size, 0);
    assert.equal(buffer.replyReceipts.size, 0);
  } finally {
    engine.stop();
    receipt.resolve({ status: 'pending' });
  }
});

test('a late stop command cannot cancel a newer reply', async t => {
  const { dir, buffer } = fixture(t);
  const grant = 'replacement-grant';
  const config = path.join(dir, 'config/wechatagent.json');
  fs.mkdirSync(path.dirname(config));
  fs.writeFileSync(
    config,
    JSON.stringify({ wechat: { whitelist: { private: ['123'] }, rosterGrants: { [key]: grant } } }),
  );
  const controls = new ReplyDeliveryControls(dir, 'legacy');
  const now = Math.floor(Date.now() / 1000);
  const readerOrder = row => String(now).padStart(20, '0') + '-' + String(row).padStart(20, '0') + '-' + 'd'.repeat(64);
  const result = { decision: 'RESPOND', text: '新回复' };
  const id = 'a'.repeat(64);
  const parts = replyDeliveryParts(result, id);
  const source = { ...message('new-reply-source'), timestamp: now, readerGrant: grant, readerOrder: readerOrder(10) };
  buffer.rememberReply(key, {
    message: source,
    deliveryId: id,
    result,
    parts,
    throughId: buffer.append(source).id,
    sending: true,
  });
  assert.equal(controls.register(key, grant, parts), true);
  const notices = [];
  const engine = new SocialEngine({
    buffer,
    deliveryControls: controls,
    decide: () => assert.fail('control messages never start a model turn'),
    send: async (target, text) => {
      assert.equal(target.readerGrant, grant);
      notices.push(text);
      return { delivered: 'database-confirmed' };
    },
  });
  t.after(() => engine.stop());
  const stop = { ...message('stale-grant-stop'), text: '停止分段' };
  engine.receive({ ...stop, readerGrant: 'legacy' });
  assert.equal(controls.inputWithdrawn(key, grant, id), false);
  assert.equal(buffer.findIncoming(stop), null);
  const replayed = {
    ...stop,
    message_id: 'older-stop',
    readerGrant: grant,
    readerReplay: 'reply',
    timestamp: now - 60,
  };
  engine.receive(replayed);
  assert.equal(controls.inputWithdrawn(key, grant, id), false);
  assert.equal(buffer.findIncoming(replayed).reply_skip_reason, 'reader_offline_context');
  assert.deepEqual(notices, []);

  engine.receive({
    ...replayed,
    message_id: 'stop-for-current-reply',
    timestamp: now,
    readerOrder: readerOrder(11),
  });
  assert.equal(controls.inputWithdrawn(key, grant, id), true);
  await until(() => notices.length === 1 && buffer.pendingReplies.size === 0);
  assert.match(notices[0], /已停止本次回复/);
});

test('recovered assistant messages are archived and live control commands remain available', async t => {
  const { buffer } = fixture(t);
  const calls = [];
  const engine = new SocialEngine({
    buffer,
    workModeFor: () => 'assistant',
    assistantAccess: () => true,
    assistantControl: async (_key, action, _message, command) => {
      calls.push([action, command.taskId]);
      return {};
    },
    decide: () => assert.fail('control messages never start a model turn'),
    send: async () => ({}),
  });
  t.after(() => engine.stop());
  const replay = {
    ...message('old-assistant-cancel'),
    text: '取消任务',
    readerReplay: 'reply',
    readerRole: 'assistant-admin',
  };
  engine.receive(replay);
  assert.deepEqual(calls, []);
  assert.equal(buffer.findIncoming(replay).reply_skip_reason, 'reader_offline_context');
  const taskId = 'T' + 'a'.repeat(16);
  engine.receive({ ...replay, message_id: 'named-cancel', text: '取消任务 ' + taskId });
  assert.equal(
    buffer.findIncoming({ ...replay, message_id: 'named-cancel' }).reply_skip_reason,
    'reader_offline_context',
  );
  const queued = { ...replay, message_id: 'legacy-assistant-queued', work_mode: 'assistant' };
  buffer.append(queued);
  assert.deepEqual(engine.unreadFor(key), []);
  assert.equal(buffer.findIncoming(queued).reply_skip_reason, 'reader_offline_context');
  engine.receive({ ...message('live-cancel'), text: '取消任务' });
  assert.deepEqual(calls, [['cancel', undefined]]);
});

for (const point of ['reply checkpoint', 'command row', 'no outstanding reply']) {
  test('a split stop repeats its original outcome after a failed write, ' + point, async t => {
    const { dir, buffer } = fixture(t);
    fs.mkdirSync(path.join(dir, 'config'));
    fs.writeFileSync(
      path.join(dir, 'config/wechatagent.json'),
      JSON.stringify({ wechat: { whitelist: { private: ['123'] } } }),
    );
    const controls = new ReplyDeliveryControls(dir, 'legacy');
    const stop = { ...message('retry-this-stop'), text: '停止分段' };
    const oldId = 'a'.repeat(64);
    const newId = 'b'.repeat(64);
    const queue = (store, deliveryId) => {
      const incoming = message('source-' + deliveryId);
      const result = { decision: 'RESPOND', text: 'queued reply' };
      const parts = replyDeliveryParts(result, deliveryId);
      assert.equal(controls.register(key, 'legacy', parts), true);
      store.rememberReply(key, {
        message: incoming,
        deliveryId,
        result,
        parts,
        throughId: store.append(incoming).id,
        sending: true,
      });
    };
    const sent = [];
    const make = buffer => {
      const engine = new SocialEngine({
        buffer,
        deliveryControls: controls,
        batchMs: 1,
        decide: () => assert.fail('a control message must not start a turn'),
        send: async (_target, text) => {
          sent.push(text);
          return { delivered: 'database-confirmed' };
        },
      });
      t.after(() => engine.stop());
      return engine;
    };
    if (point !== 'no outstanding reply') queue(buffer, oldId);
    const engine = make(buffer);
    const fail = () => {
      throw Error('fixture write failed');
    };
    if (point === 'reply checkpoint') t.mock.method(buffer, 'rememberReply', fail);
    else t.mock.method(buffer, 'append', fail);

    assert.throws(() => engine.receive(stop), /fixture write failed/);
    engine.stop();
    assert.equal(buffer.findIncoming(stop), null);
    assert.equal(controls.inputWithdrawn(key, 'legacy', oldId), point !== 'no outstanding reply');

    const reopened = new MessageBuffer(buffer.file);
    if (point !== 'no outstanding reply') {
      const finishing = make(reopened);
      finishing.replay(key);
      await until(() => reopened.pendingReplies.size === 0 && !finishing.running.has(key));
      finishing.stop();
      assert.deepEqual(sent, []);
    }
    queue(reopened, newId);
    const retried = make(reopened);
    retried.receive(stop);
    assert.equal(controls.inputWithdrawn(key, 'legacy', newId), false);
    assert.equal(reopened.pendingReplies.get(key)?.deliveryId, newId);
    await until(() => sent.length === 1);
    assert.match(sent[0], point === 'no outstanding reply' ? /当前没有等待发送的分段/ : /已停止本次回复/);
    const after = new MessageBuffer(buffer.file);
    assert.equal(after.findIncoming(stop)?.processed, true);
  });
}

test('an assistant control is processed in the first durable message snapshot', async t => {
  const { buffer } = fixture(t);
  const command = { ...message('status-control'), text: '任务状态' };
  const calls = [];
  const engine = new SocialEngine({
    buffer,
    workModeFor: () => 'assistant',
    assistantAccess: () => true,
    assistantControl: async (_key, action) => {
      calls.push(action);
      return {};
    },
    decide: () => assert.fail('a control message must not start a turn'),
    send: async () => ({}),
  });
  t.after(() => engine.stop());
  t.mock.method(buffer, 'saveMedia', () => {
    throw Error('fixture write after append failed');
  });
  assert.doesNotThrow(() => engine.receive(command));
  assert.equal(new MessageBuffer(buffer.file).findIncoming(command)?.processed, true);
  engine.receive(command);
  assert.deepEqual(calls, ['status']);
});

test('a reply with no receipt remains unconfirmed even when the send call returns successfully', async t => {
  const { buffer } = fixture(t);
  const engine = new SocialEngine({
    buffer,
    batchMs: 1,
    decide: async () => 'RESPOND: fixture reply',
    send: async () => ({}),
  });
  t.after(() => engine.stop());
  engine.receive(message('missing-receipt'));
  await until(() => buffer.recent(key).some(row => row.outgoing));
  assert.equal(buffer.recent(key).find(row => row.outgoing).delivery_status, 'unconfirmed');
});

test('duplicate and per-line RESPOND envelopes are removed before replies are split into messages', () => {
  for (const raw of [
    'RESPOND: RESPOND: 你好',
    'RESPOND: respond：你好',
    'respond: RESPOND: respond: 你好',
    'RESPOND: \u200brespond\u200b:\ufeff你好',
    'RESPOND:\nRESPOND:\n你好',
    '```text\nRESPOND: respond: 你好\n```',
  ]) {
    assert.deepEqual(parseSocialDecision(raw), { decision: 'RESPOND', text: '你好' }, raw);
  }
  const result = parseSocialDecision('RESPOND: respond: 第一段\n\nRESPOND：第二段\nrespond: 同一段续行');
  assert.deepEqual(result.textParts, ['第一段', '第二段\n同一段续行']);
  assert.equal(result.text, '第一段\n\n第二段\n同一段续行');
  assert.equal(cleanReplyProtocol(result.text), result.text);
});

test('switching a group to mention-only cancels an unsent retry while a new mention is answered', async t => {
  const f = fixture(t);
  const group = 'wechat:group:123@chatroom';
  const sends = [];
  let mode = 'hybrid';
  const engine = new SocialEngine({
    buffer: f.buffer,
    modeFor: () => mode,
    batchMs: 1,
    minIntervalMs: 0,
    deliveryRetry: { busyDelayMs: 100 },
    decide: async () => 'RESPOND: fixture reply',
    send: async (target, _text, { receiptOnly }) => {
      assert.equal(receiptOnly, false);
      sends.push(target.message_id);
      if (target.message_id === 'unmentioned') throw Object.assign(Error('fixture busy'), { code: 'SENDER_BUSY' });
      return { delivered: 'database-confirmed' };
    },
  });
  t.after(() => engine.stop());
  engine.receive({ ...message('unmentioned', 'group'), direct_mention: false });
  await until(() => f.buffer.pendingReplies.get(group)?.parts[0]?.busyAttempts === 1);
  mode = 'mention';
  await until(() => !f.buffer.pendingReplies.has(group));
  assert.deepEqual(sends, ['unmentioned']);
  engine.receive({ ...message('mentioned', 'group'), mentionTarget: 'self' });
  await until(() => sends.length === 2);
  assert.deepEqual(sends, ['unmentioned', 'mentioned']);
});

test('normal English, inline quotations and closed code examples preserve their content', () => {
  const bodies = [
    'Please respond: hello',
    'respond to this message',
    '这里讨论 RESPOND: 的含义',
    '`RESPOND:` 是一个标记',
    '> RESPOND: 这是引用',
    'Response: 保留普通内容',
    '示例：\n```text\nRESPOND: 你好\n\nrespond: 第二行示例\n```',
  ];
  for (const body of bodies) {
    const result = parseSocialDecision('RESPOND: ' + body);
    assert.equal(result.decision, 'RESPOND');
    assert.equal(result.text, body);
    assert.equal(hasReplyProtocolControl(body), false);
  }
  assert.equal(
    parseSocialDecision('RESPOND: ' + bodies.at(-1)).textParts,
    undefined,
    'Do not split a fenced example across messages',
  );
});

test('normalizing envelopes preserves silence and bound sticker choices without accepting reasoning or unmarked prose', () => {
  const id = 'a'.repeat(64);
  assert.equal(parseSocialDecision('RESPOND: respond: SILENT').decision, 'SILENT');
  assert.deepEqual(parseSocialDecision('RESPOND: RESPOND: [STICKER:S1]', { S1: id }), {
    decision: 'STICKER',
    stickerId: id,
    text: '',
  });
  const caption = parseSocialDecision(
    'RESPOND: respond: 早\nRESPOND: [STICKER:S1]',
    { S1: id },
    { allowStickerCaption: true },
  );
  assert.equal(caption.text, '早');
  assert.equal(caption.stickerId, id);
  for (const raw of [
    'RESPOND:respond:<think>private</think>你好',
    'RESPOND:respond:[S9]',
    '没有协议的普通模型输出',
    'RESPOND: ' + 'RESPOND: '.repeat(20) + '你好',
  ])
    assert.equal(parseSocialDecision(raw).decision, 'INVALID', raw);
});

test('ambiguous decorated headers receive only one bounded correction with a fresh deterministic repair identity', async () => {
  const raw = 'RESPOND: **RESPOND:** 你好',
    metadata = { batchId: 'b'.repeat(64) };
  assert.equal(parseSocialDecision(raw).decision, 'INVALID');
  const ids = [];
  let calls = 0;
  for (let i = 0; i < 2; i++) {
    const result = await resolveSocialDecision({
      rawOutput: raw,
      key,
      metadata,
      decide: async (_key, _prompt, options) => {
        calls++;
        ids.push(options.batchId);
        return 'RESPOND: respond: 你好';
      },
    });
    assert.equal(result.result.text, '你好');
  }
  assert.equal(calls, 2);
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[0], metadata.batchId);
  let invalidCalls = 0;
  const invalid = await resolveSocialDecision({
    rawOutput: raw,
    key,
    metadata,
    decide: async () => {
      invalidCalls++;
      return raw;
    },
  });
  assert.equal(invalidCalls, 1);
  assert.equal(invalid.result.decision, 'INVALID');
});

test('private and group replies deliver cleaned bodies once and record only actual text', async t => {
  for (const kind of ['private', 'group']) {
    const f = fixture(t),
      sent = [];
    let calls = 0;
    const engine = new SocialEngine({
      buffer: f.buffer,
      batchMs: 1,
      minIntervalMs: 0,
      privateMinIntervalMs: 0,
      maxPerMinute: 100,
      maxPerTenMinutes: 1000,
      decide: async () => {
        calls++;
        return 'RESPOND: respond: 第一段\n\nRESPOND: 第二段';
      },
      send: async (_target, text) => {
        sent.push(text);
        return { delivered: 'database-confirmed' };
      },
    });
    t.after(() => engine.stop());
    const msg = message(kind, kind),
      chat = 'wechat:' + kind + ':' + msg.conversation_id;
    engine.receive(msg);
    await until(() => f.buffer.unread(chat).length === 0 && !engine.running.has(chat));
    assert.deepEqual(sent, ['第一段', '第二段']);
    assert.equal(calls, 1);
    assert.deepEqual(
      f.buffer
        .recent(chat)
        .filter(row => row.outgoing)
        .map(row => row.text),
      sent,
    );
  }
});

test('an old queued protocol prefix is cancelled without changing confirmed history or blocking new messages', async t => {
  const f = fixture(t),
    msg = message(),
    sent = [];
  let calls = 0;
  f.buffer.append(msg);
  const throughId = f.buffer.unread(key)[0].id,
    deliveryId = 'c'.repeat(64);
  const result = {
      decision: 'RESPOND',
      text: '已确认第一段\n\nRESPOND: 旧的第二段',
      textParts: ['已确认第一段', 'RESPOND: 旧的第二段'],
    },
    parts = replyDeliveryParts(result, deliveryId);
  parts[0].state = 'confirmed';
  f.buffer.recordReplyPart(
    key,
    { deliveryId: parts[0].deliveryId },
    { ...msg, text: '已确认第一段', delivery_status: 'confirmed', timestamp: Date.now() / 1000 },
  );
  f.buffer.rememberReply(key, { result, parts, throughId, deliveryId, message: msg, sending: true });
  const restored = new MessageBuffer(path.join(f.dir, 'messages.json')),
    engine = new SocialEngine({
      buffer: restored,
      batchMs: 1,
      privateMinIntervalMs: 0,
      maxPerMinute: 100,
      decide: async () => {
        calls++;
        return 'RESPOND: respond: 新回复';
      },
      send: async (_target, text) => {
        sent.push(text);
        return { delivered: 'database-confirmed' };
      },
    });
  t.after(() => engine.stop());
  engine.replay(key);
  await until(
    () => restored.pendingReplies.size === 0 && restored.unread(key).length === 0 && !engine.running.has(key),
  );
  assert.deepEqual(sent, []);
  assert.equal(calls, 0);
  assert.match(restored.contextNotices.get(key).text, /协议/);
  assert.deepEqual(
    restored
      .recent(key)
      .filter(row => row.outgoing)
      .map(row => row.text),
    ['已确认第一段'],
  );
  engine.receive(message('after-restart'));
  await until(() => sent.length === 1 && restored.unread(key).length === 0);
  assert.deepEqual(sent, ['新回复']);
  assert.equal(calls, 1);
  assert.equal(restored.recent(key).filter(row => row.outgoing && row.text === '已确认第一段').length, 1);
});

test('proactive greetings normalize protocol without changing the existing message layout', async t => {
  const f = fixture(t),
    sent = [];
  let now = Date.parse('2026-10-19T02:00:00Z'),
    calls = 0;
  const settings = {
    wechat: {
      whitelist: { private: ['123'], groups: [] },
      proactive: {
        ...PROACTIVE_DEFAULTS,
        enabled: true,
        mode: 'greeting',
        intervalMinutes: 30,
        idleMinutes: 5,
        jitterMinutes: 0,
        chats: { [key]: true },
      },
    },
  };
  const social = new SocialEngine({
    buffer: f.buffer,
    decide: async () => 'SILENT',
    send: async () => {
      throw Error('No unrelated sends');
    },
  });
  t.after(() => social.stop());
  const proactive = new ProactiveEngine({
    stateFile: path.join(f.dir, 'proactive.json'),
    buffer: f.buffer,
    social,
    settingsFor: () => settings,
    personaFor: () => ({ persona: 'offline fixture persona', personaName: 'Fixture' }),
    selfIdFor: () => '99',
    now: () => now,
    random: () => 0,
    decide: async () => {
      calls++;
      return 'RESPOND: respond: 早\n\nRESPOND: 今天好好聊';
    },
    send: async (_target, text) => {
      sent.push(text);
      return { delivered: 'database-confirmed' };
    },
  });
  await proactive.tick();
  now += 30 * 60000;
  await proactive.tick();
  assert.equal(calls, 1);
  assert.equal(sent.join('\n\n'), '早\n\n今天好好聊');
  assert(sent.every(text => !hasReplyProtocolControl(text)));
});

test('assistant proactive chat opts in separately, waits for task activity and uses the tool-free lane', async t => {
  const f = fixture(t);
  const chatBuffer = new MessageBuffer(path.join(f.dir, 'assistant-chat.json'));
  const taskEngine = new SocialEngine({ buffer: f.buffer });
  const chatEngine = new SocialEngine({ buffer: chatBuffer });
  t.after(() => {
    taskEngine.stop();
    chatEngine.stop();
  });
  let now = Date.parse('2026-10-19T02:00:00Z');
  const settings = {
    wechat: {
      whitelist: { private: ['123'], groups: [] },
      workModes: { [key]: 'assistant' },
      assistant: { administrators: ['123'] },
      proactive: {
        ...PROACTIVE_DEFAULTS,
        enabled: true,
        intervalMinutes: 30,
        jitterMinutes: 0,
        chats: { [key]: true },
      },
    },
  };
  const calls = [],
    sends = [];
  const proactive = new ProactiveEngine({
    stateFile: path.join(f.dir, 'assistant-proactive.json'),
    buffer: chatBuffer,
    social: chatEngine,
    taskContext: { buffer: f.buffer, social: taskEngine },
    settingsFor: () => settings,
    personaFor: () => ({ persona: 'Fixture', personaName: 'Fixture' }),
    selfIdFor: () => '99',
    now: () => now,
    decide: async (_key, prompt, metadata) => {
      calls.push({ prompt, metadata });
      return 'RESPOND: 早上好';
    },
    send: async (_target, text) => {
      sends.push(text);
      return { delivered: 'database-confirmed' };
    },
  });
  await proactive.tick();
  assert.equal(proactive.state.chats[key], undefined);
  settings.wechat.proactive.assistantChats = { [key]: true };
  await proactive.tick();
  assert.deepEqual(calls, []);
  now += 30 * 60000;
  taskEngine.running.add(key);
  await proactive.tick();
  assert.deepEqual(calls, []);
  taskEngine.running.delete(key);
  f.buffer.recordReplyPart(
    key,
    { deliveryId: 'f'.repeat(64) },
    {
      ...message(),
      text: 'PRIVATE_TASK_CONTEXT',
      timestamp: now / 1000 - 9000,
      delivery_status: 'confirmed',
    },
  );
  await proactive.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].metadata.scheduledChat, true);
  assert.equal(calls[0].metadata.assistantChatOnly, true);
  assert.equal(calls[0].metadata.searchOptOut, true);
  assert.doesNotMatch(calls[0].prompt, /PRIVATE_TASK_CONTEXT/);
  assert.deepEqual(sends, ['早上好']);
  assert.equal(chatBuffer.recent(key).at(-1)?.text, '早上好');
});

for (const boundary of ['assistant mode changed during generation', 'a media reply is pending']) {
  test('proactive text defers to the current conversation, ' + boundary, async t => {
    const f = fixture(t);
    let now = Date.parse('2026-10-19T02:00:00Z'),
      decisions = 0,
      sends = 0;
    const settings = {
      wechat: {
        whitelist: { private: ['123', '789'], groups: [] },
        proactive: {
          ...PROACTIVE_DEFAULTS,
          enabled: true,
          intervalMinutes: 30,
          jitterMinutes: 0,
          chats: { [key]: true },
        },
      },
    };
    const social = new SocialEngine({ buffer: f.buffer, send: () => assert.fail('No ordinary text in this fixture') });
    t.after(() => social.stop());
    const modeChanged = boundary.startsWith('assistant');
    const proactive = new ProactiveEngine({
      stateFile: path.join(f.dir, 'proactive.json'),
      buffer: f.buffer,
      social,
      settingsFor: () => settings,
      personaFor: () => ({ persona: 'Fixture', personaName: 'Fixture' }),
      selfIdFor: () => '99',
      now: () => now,
      random: () => 0,
      decide: async () => {
        decisions++;
        if (modeChanged) settings.wechat.workModes = { [key]: 'assistant' };
        return 'RESPOND: 早';
      },
      send: async () => {
        sends++;
        return { delivered: 'database-confirmed' };
      },
    });
    const queuedMedia = (id, target) => ({
      key: 'wechat:private:' + target,
      message: { ...message('paused-media'), conversation_id: target },
      part: { deliveryId: id, stickerId: 'c'.repeat(64), state: 'queued' },
      createdAt: now,
      expiresAt: now + 60000,
    });
    await proactive.tick();
    now += 30 * 60000;
    const ownMedia = 'a'.repeat(64),
      otherMedia = 'b'.repeat(64);
    if (!modeChanged) {
      f.buffer.mediaReplies.set(ownMedia, queuedMedia(ownMedia, '123'));
      f.buffer.mediaReplies.set(otherMedia, queuedMedia(otherMedia, '789'));
    }
    await proactive.tick();
    assert.equal(sends, 0);
    assert.equal(decisions, Number(modeChanged));
    if (!modeChanged) {
      const submitted = f.buffer.mediaReplies.get(ownMedia);
      submitted.observeOnly = true;
      submitted.part.state = 'submitted';
      await proactive.tick();
      assert.equal(sends, 1);
      assert.equal(f.buffer.mediaReplies.has(ownMedia), true);
      assert.equal(decisions, 1);
    }
  });
}

test('an obsolete queued input leaves history but releases proactive work in the replacement grant', async t => {
  const { dir, buffer } = fixture(t);
  let now = Date.parse('2026-10-19T02:00:00Z');
  const grant = 'replacement-grant';
  const wechat = {
    whitelist: { private: ['123'], groups: [] },
    rosterGrants: { [key]: grant },
    proactive: {
      ...PROACTIVE_DEFAULTS,
      enabled: true,
      mode: 'greeting',
      intervalMinutes: 30,
      idleMinutes: 5,
      jitterMinutes: 0,
      chats: { [key]: true },
    },
  };
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config/wechatagent.json'), JSON.stringify({ wechat }));
  const old = { ...message('retired-unread'), readerGrant: 'legacy', timestamp: now / 1000 - 1200 };
  const row = buffer.append(old);
  const ids = [row.id];
  buffer.rememberRequest(key, {
    rowIds: ids,
    throughId: row.id,
    signature: 'a'.repeat(64),
    prompt: 'saved prior grant input',
    metadata: { batchId: 'b'.repeat(64), historyExcludeIds: ids },
    stickerRefs: {},
    annotationRefs: {},
    stickerChoices: [],
  });
  const controls = new ReplyDeliveryControls(dir, 'legacy');
  const social = new SocialEngine({
    buffer,
    deliveryControls: controls,
    decide: () => assert.fail('obsolete input must not reach the model'),
    send: () => assert.fail('obsolete input must not be answered'),
  });
  t.after(() => social.stop());
  const sent = [];
  const logs = [];
  const proactive = new ProactiveEngine({
    stateFile: path.join(dir, 'proactive.json'),
    buffer,
    social,
    settingsFor: () => ({ wechat }),
    personaFor: () => ({ persona: 'Fixture', personaName: 'Fixture' }),
    selfIdFor: () => '99',
    now: () => now,
    random: () => 0,
    decide: async () => 'RESPOND: 当前授权的主动消息',
    log: line => logs.push(line),
    send: async (target, text) => {
      sent.push([target.readerGrant, text]);
      return { delivered: 'database-confirmed' };
    },
  });

  await proactive.tick();
  now += 30 * 60000;
  await proactive.tick();
  assert.deepEqual(sent, [[grant, '当前授权的主动消息']], logs.join('\n'));
  const restored = new MessageBuffer(buffer.file);
  assert.equal(restored.findIncoming(old)?.reply_skip_reason, 'conversation_grant_changed');
  assert.equal(restored.unread(key).length, 0);
  assert.equal(restored.pendingRequests.has(key), false);
});

for (const boundary of ['policy disabled and reenabled', 'conversation changed']) {
  test('a retired proactive reply stays receipt-only after ' + boundary, async t => {
    const f = fixture(t);
    const clock = Date.parse('2026-10-19T02:00:00Z');
    let now = clock;
    const wechat = {
      whitelist: { private: ['123'], groups: [] },
      proactive: {
        ...PROACTIVE_DEFAULTS,
        enabled: true,
        mode: 'greeting',
        intervalMinutes: 30,
        jitterMinutes: 0,
        chats: { [key]: true },
      },
    };
    fs.mkdirSync(path.join(f.dir, 'config'));
    fs.writeFileSync(path.join(f.dir, 'config/wechatagent.json'), JSON.stringify({ wechat }));
    const controls = new ReplyDeliveryControls(f.dir, 'legacy');
    const sent = [];
    const passive = [];
    const otherAdmissions = [];
    const held = Promise.withResolvers();
    const social = new SocialEngine({
      buffer: f.buffer,
      deliveryControls: controls,
      batchMs: 1,
      privateMinIntervalMs: 0,
      decide: async () => 'RESPOND: fresh reply',
      send: async (_message, text) => {
        sent.push(text);
        return { delivered: 'database-confirmed' };
      },
    });
    t.after(() => {
      social.stop();
      held.resolve({ pending: true });
    });
    const options = {
      stateFile: path.join(f.dir, 'proactive.json'),
      buffer: f.buffer,
      social,
      settingsFor: () => ({ wechat }),
      personaFor: () => ({ persona: 'Fixture', personaName: 'Fixture' }),
      selfIdFor: () => '99',
      now: () => now,
      random: () => 0,
      decide: async () => 'RESPOND: proactive reply',
      send: async (target, _text, options) => {
        if (target.conversation_id === '789') {
          otherAdmissions.push(options);
          return { delivered: 'database-confirmed' };
        }
        passive.push(options);
        if (boundary === 'conversation changed' && passive.length === 2) return held.promise;
        return { pending: true };
      },
    };
    const proactive = new ProactiveEngine(options);
    await proactive.tick();
    now += 30 * 60000;
    await proactive.tick();
    const id = proactive.state.chats[key].job.id;
    assert.equal(passive.length, 1);
    assert.equal(passive[0].receiptOnly, false);

    if (boundary === 'conversation changed') {
      f.buffer.append({ ...message('updated-context'), timestamp: now / 1000 - 60 }, { processed: true });
      const checking = proactive.tick();
      try {
        await until(() => passive.length === 2);
        social.receive(message('fresh-after-proactive'));
        await until(() => sent.length === 1 && !social.running.has(key));
        assert.deepEqual(sent, ['fresh reply']);
        wechat.whitelist.private.push('789');
        wechat.proactive.chats['wechat:private:789'] = true;
        fs.writeFileSync(path.join(f.dir, 'config/wechatagent.json'), JSON.stringify({ wechat }));
        await proactive.tick();
        now += 30 * 60000;
        await proactive.tick();
        assert.equal(otherAdmissions.length, 1);
        assert.equal(otherAdmissions[0].receiptOnly, false);
        assert.equal(passive.length, 2);
      } finally {
        held.resolve({ pending: true });
        await checking;
      }
    } else {
      wechat.proactive.enabled = false;
      await proactive.tick();
      wechat.proactive.enabled = true;
      const restored = new ProactiveEngine(options);
      await restored.tick();
      assert.equal(restored.state.chats[key].job.id, id);
    }

    assert.equal(passive[1].observeOnly, true);
    assert.ok(passive.slice(1).every(call => call.deliveryId === id && call.receiptOnly && call.observeOnly));
    assert.equal(controls.inputWithdrawn(key, 'legacy', id), true);
  });
}

for (const boundary of [
  'still eligible',
  'disabled',
  'expired',
  'new reply',
  'roster removed',
  'lost response',
  'regranted before admission',
  'regranted with receipt',
  'retry after response loss',
  'clock advances while saving the draft',
]) {
  test('a proactive send keeps tracking its original receipt after restart, ' + boundary, async t => {
    const f = fixture(t);
    let now = Date.parse('2026-10-19T02:00:00Z');
    const regranted = boundary.startsWith('regranted');
    const retry = boundary === 'retry after response loss';
    const clockAdvances = boundary === 'clock advances while saving the draft';
    const originalGrant = 'original-grant';
    const settings = {
      wechat: {
        whitelist: { private: ['123'], groups: [] },
        rosterGrants: { [key]: originalGrant },
        proactive: {
          ...PROACTIVE_DEFAULTS,
          enabled: true,
          mode: 'greeting',
          intervalMinutes: 30,
          idleMinutes: 5,
          jitterMinutes: 0,
          chats: { [key]: true },
        },
      },
    };
    const social = new SocialEngine({
      buffer: f.buffer,
      decide: async () => 'SILENT',
      send: async () => assert.fail(),
    });
    t.after(() => social.stop());
    const calls = [];
    let decisions = 0;
    let sentAt;
    const options = {
      stateFile: path.join(f.dir, 'proactive.json'),
      buffer: f.buffer,
      social,
      settingsFor: () => settings,
      personaFor: () => ({ persona: 'Fixture', personaName: 'Fixture' }),
      selfIdFor: () => '99',
      now: () => (clockAdvances ? now++ : now),
      random: () => 0,
      decide: async () => {
        decisions++;
        return 'RESPOND: 早';
      },
      send: async (target, _text, options) => {
        calls.push({ ...options, rosterGrant: target.readerGrant });
        if (calls.length === 1) {
          sentAt = now;
          if (boundary === 'lost response' || regranted || retry) throw Error('fixture admission response lost');
          return { pending: true };
        }
        if (boundary === 'expired' && calls.length === 2) return { pending: true };
        if (boundary === 'regranted before admission') return { delivered: 'unconfirmed' };
        return { confirmed: true, sentAt };
      },
    };
    const proactive = new ProactiveEngine(options);
    await proactive.tick();
    now += 30 * 60000;
    await proactive.tick();
    const original = proactive.state.chats[key].job;
    assert.equal(original.id, calls[0].deliveryId);
    assert.equal(original.message.readerGrant, originalGrant);
    assert.equal(calls[0].receiptOnly, false);
    if (boundary === 'disabled' || boundary === 'lost response') settings.wechat.proactive.enabled = false;
    if (boundary === 'expired') now = original.expiresAt;
    if (boundary === 'roster removed') settings.wechat.whitelist.private = [];
    if (regranted) settings.wechat.rosterGrants[key] = 'replacement-grant';
    if (boundary === 'new reply') {
      const incoming = message('new-reply');
      const row = f.buffer.append(incoming);
      f.buffer.rememberReply(key, { message: incoming, throughId: row.id, deliveryId: 'c'.repeat(64) });
    }

    const restored = new ProactiveEngine(options);
    await restored.tick();
    if (boundary === 'expired') {
      assert.equal(restored.state.chats[key].job.id, original.id);
      now += 60000;
      await restored.tick();
    }
    assert.equal(decisions, 1);
    const { job, history } = restored.state.chats[key];
    assert.equal(job, null);
    assert.deepEqual(
      history.map(row => row.deliveryId),
      [original.id],
    );
    for (const call of calls.slice(1)) {
      assert.equal(call.deliveryId, original.id);
      assert.equal(call.rosterGrant, originalGrant);
      assert.equal(call.receiptOnly, !retry);
      assert.equal(call.observeOnly, !retry && !clockAdvances && boundary !== 'still eligible');
    }
    const recorded = f.buffer.recent(key).filter(row => row.delivery_id === original.id);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].delivery_status, boundary === 'regranted before admission' ? 'unconfirmed' : 'confirmed');
    if (recorded[0].delivery_status === 'confirmed') assert.equal(recorded[0].timestamp, sentAt / 1000);
    if (boundary === 'new reply') {
      assert.equal(f.buffer.pendingReplies.get(key).deliveryId, 'c'.repeat(64));
      assert.equal(f.buffer.unread(key).length, 1);
    }
  });
}

test('a legacy proactive draft containing a protocol marker is cancelled on restart', async t => {
  const f = fixture(t),
    sent = [];
  let now = Date.parse('2026-10-19T02:00:00Z'),
    calls = 0;
  const settings = {
    wechat: {
      whitelist: { private: ['123'], groups: [] },
      proactive: {
        ...PROACTIVE_DEFAULTS,
        enabled: true,
        mode: 'greeting',
        intervalMinutes: 30,
        idleMinutes: 5,
        jitterMinutes: 0,
        chats: { [key]: true },
      },
    },
  };
  const social = new SocialEngine({
    buffer: f.buffer,
    decide: async () => 'SILENT',
    send: async () => {
      throw Error('No unrelated sends');
    },
  });
  t.after(() => social.stop());
  const stateFile = path.join(f.dir, 'proactive.json'),
    make = () =>
      new ProactiveEngine({
        stateFile,
        buffer: f.buffer,
        social,
        settingsFor: () => settings,
        personaFor: () => ({ persona: 'offline fixture persona', personaName: 'Fixture' }),
        selfIdFor: () => '99',
        now: () => now,
        random: () => 0,
        decide: async () => {
          calls++;
          return 'RESPOND: 早';
        },
        send: async () => {
          throw Object.assign(Error('fixture busy'), { code: 'SENDER_BUSY' });
        },
      });
  const proactive = make();
  await proactive.tick();
  now += 30 * 60000;
  await proactive.tick();
  assert.equal(calls, 1);
  assert(proactive.state.chats[key].job);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.chats[key].job.text = 'RESPOND: 旧草稿';
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const restored = make();
  restored.send = async (_target, text) => sent.push(text);
  await restored.tick();
  await restored.tick();
  assert.deepEqual(sent, []);
  assert.equal(calls, 1);
  assert.equal(restored.state.chats[key].job, null);
  assert(f.buffer.contextNotices.has(key));
  assert.equal(f.buffer.recent(key).filter(row => row.outgoing).length, 0);
});

// ---- DSH RESPOND_VOICE: one voice message per turn, delivered by WCA ----
import crypto from 'node:crypto';
import { SOCIAL_VOICE_NOTICE, MAX_VOICE_REPLY_CHARS } from '../components/qq-bridge/src/core/decision-format.js';

test('RESPOND_VOICE parses only when voice is offered and suitable; otherwise valid text stays text', () => {
  assert.equal(MAX_VOICE_REPLY_CHARS, 400);
  assert.deepEqual(parseSocialDecision('RESPOND_VOICE: 好的，我念给你听。', {}, { allowVoice: true }), {
    decision: 'RESPOND',
    mode: 'voice',
    text: '好的，我念给你听。',
  });
  assert.deepEqual(parseSocialDecision('语音回复：好的', {}, { allowVoice: true }), {
    decision: 'RESPOND',
    mode: 'voice',
    text: '好的',
  });
  assert.equal(parseSocialDecision('RESPOND_VOICE: 好的，我念给你听。').mode, undefined);
  assert.equal(parseSocialDecision('RESPOND_VOICE: 好的，我念给你听。').text, '好的，我念给你听。');
  for (const text of [
    '链接是 https://example.com/a',
    'www.example.test',
    '执行 `npm test`',
    '```\nls -la\n```',
    '长'.repeat(MAX_VOICE_REPLY_CHARS + 1),
  ]) {
    const result = parseSocialDecision('RESPOND_VOICE: ' + text, {}, { allowVoice: true });
    assert.equal(result.decision, 'RESPOND');
    assert.equal(result.mode, undefined);
    assert(!/RESPOND_VOICE/.test(result.text));
  }
  assert.deepEqual(parseSocialDecision('RESPOND_VOICE: SILENT', {}, { allowVoice: true }), {
    decision: 'SILENT',
    text: '',
  });
  assert.equal(parseSocialDecision('RESPOND_VOICE: ', {}, { allowVoice: true }).decision, 'INVALID');
  assert.equal(cleanReplyProtocol('RESPOND_VOICE: 你好'), '你好');
  assert(hasReplyProtocolControl('你好\nRESPOND_VOICE: 再见'));
  assert.deepEqual(
    replyDeliveryParts({ decision: 'RESPOND', mode: 'voice', text: '你好' }, 'e'.repeat(64)).map(
      part => part.voiceText,
    ),
    ['你好'],
  );
});

function voiceEngine(f, { voiceAllowed = true, sendVoice, decide, buffer = f.buffer, ...options } = {}) {
  const sent = [],
    voiced = [],
    prompts = [];
  let calls = 0;
  const engine = new SocialEngine({
    ...options,
    buffer,
    batchMs: 1,
    minIntervalMs: 0,
    privateMinIntervalMs: 0,
    maxPerMinute: 100,
    maxPerTenMinutes: 1000,
    deliveryRetry: { receiptDelayMs: 5, busyDelayMs: 5 },
    voiceReplyFor: async () => voiceAllowed,
    decide: async (_key, prompt) => {
      calls++;
      prompts.push(prompt);
      return decide ? decide() : 'RESPOND_VOICE: 我用语音回你。';
    },
    sendVoice: async (target, text, options) => {
      voiced.push({
        text,
        deliveryId: options.deliveryId,
        chat: target.conversation_id,
        receiptOnly: options.receiptOnly,
      });
      return sendVoice ? sendVoice(voiced.length) : { status: 'confirmed' };
    },
    send: async (_target, text, options) => {
      sent.push({ text, deliveryId: options?.deliveryId });
      return { delivered: 'database-confirmed' };
    },
  });
  return { engine, sent, voiced, prompts, calls: () => calls };
}

test('authorized assistant tasks can choose a short voice reply', async t => {
  const f = fixture(t),
    run = voiceEngine(f, { workModeFor: () => 'assistant', assistantAccess: () => true, assistantBatchMs: 1 });
  t.after(() => run.engine.stop());
  run.engine.receive({ ...message('assistant-voice'), sender_wxid: 'fixture-admin' });
  await until(() => run.voiced.length === 1);
  assert.match(run.prompts[0], /RESPOND_VOICE/);
  assert.equal(run.sent.length, 0);
});

test('turning off stickers still offers the authorized voice reply', async t => {
  const f = fixture(t),
    run = voiceEngine(f, { stickerPolicyFor: () => ({ enabled: false }) });
  t.after(() => run.engine.stop());
  run.engine.receive(message('voice-without-sticker'));
  await until(() => run.voiced.length === 1);
  assert.match(run.prompts[0], /本轮原生表情发送已关闭/);
  assert.doesNotMatch(run.prompts[0], /只能文字回复/);
  assert.ok(run.prompts[0].includes(SOCIAL_VOICE_NOTICE));
  assert.deepEqual(run.sent, []);
});

test('a voice turn sends exactly one voice message, no text, and a restart sends nothing more', async t => {
  const f = fixture(t),
    run = voiceEngine(f);
  t.after(() => run.engine.stop());
  run.engine.receive(message('voice-1'));
  await until(() => f.buffer.unread(key).length === 0 && !run.engine.running.has(key) && run.voiced.length === 1);
  assert(run.prompts[0].includes(SOCIAL_VOICE_NOTICE));
  assert.deepEqual(run.sent, []);
  assert.equal(run.voiced[0].text, '我用语音回你。');
  assert.match(run.voiced[0].deliveryId, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    f.buffer
      .recent(key)
      .filter(row => row.outgoing)
      .map(row => row.text),
    ['[语音] 我用语音回你。'],
  );
  run.engine.receive(message('voice-1'));
  await new Promise(resolve => setTimeout(resolve, 60));
  run.engine.stop();
  const restored = new MessageBuffer(path.join(f.dir, 'messages.json')),
    again = voiceEngine(f, { buffer: restored });
  t.after(() => again.engine.stop());
  again.engine.replay(key);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(
    [run.voiced.length, run.sent.length, again.voiced.length, again.sent.length, again.calls()],
    [1, 0, 0, 0, 0],
  );
});

test('a definite synthesis failure falls back to one text message with its own delivery ID', async t => {
  const f = fixture(t),
    run = voiceEngine(f, { sendVoice: () => ({ status: 'rejected', fallback: true, error: 'VOICE_TTS_FAILED' }) });
  t.after(() => run.engine.stop());
  run.engine.receive(message('voice-2'));
  await until(() => run.sent.length === 1 && !run.engine.running.has(key));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(run.voiced.length, 1);
  assert.equal(run.sent.length, 1);
  assert.equal(run.sent[0].text, '我用语音回你。');
  assert.equal(
    run.sent[0].deliveryId,
    crypto
      .createHash('sha256')
      .update(run.voiced[0].deliveryId + '\0voice-fallback')
      .digest('hex'),
  );
  assert.deepEqual(
    f.buffer
      .recent(key)
      .filter(row => row.outgoing)
      .map(row => row.text),
    ['我用语音回你。'],
  );
});

test('uncertain or rejected voice deliveries are never replaced by text', async t => {
  for (const [label, sendVoice] of [
    ['unconfirmed', () => ({ status: 'unconfirmed' })],
    ['rejected', () => ({ status: 'rejected', error: 'VOICE_NATIVE_REJECTED' })],
    ['uncertain fallback', () => ({ status: 'unconfirmed', fallback: true })],
    ['submitted fallback', () => ({ status: 'rejected', fallback: true, submitted: true })],
    [
      'timeout',
      () => {
        throw Error('OneBot action timeout: send_voice_text');
      },
    ],
  ]) {
    const f = fixture(t),
      run = voiceEngine(f, { sendVoice });
    t.after(() => run.engine.stop());
    run.engine.receive(message('voice-' + label));
    await until(
      () => f.buffer.unread(key).length === 0 && !run.engine.running.has(key) && f.buffer.pendingReplies.size === 0,
    );
    assert.deepEqual(run.sent, [], label);
    assert(run.voiced.length >= 1, label);
    assert.equal(
      new Set(run.voiced.map(item => item.deliveryId)).size,
      1,
      label + ' keeps one delivery ID for receipt checks',
    );
    assert.equal(run.voiced.length, 1, label);
  }
});

for (const boundary of ['busy', 'restart', 'revoked grant']) {
  test('an approved text fallback respects admission after ' + boundary, async t => {
    const f = fixture(t);
    const config = path.join(f.dir, 'config/wechatagent.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const wechat = { whitelist: { groups: [], private: ['123'] } };
    const save = () => fs.writeFileSync(config, JSON.stringify({ wechat }));
    save();
    const voice = [];
    const text = [];
    let admitted = false;
    let interrupted = false;
    const make = buffer => {
      const engine = new SocialEngine({
        buffer,
        batchMs: 1,
        minIntervalMs: 0,
        privateMinIntervalMs: 0,
        deliveryRetry: { receiptDelayMs: 5, busyDelayMs: 5 },
        deliveryControls: new ReplyDeliveryControls(f.dir, 'legacy'),
        voiceReplyFor: async () => true,
        decide: async () => 'RESPOND_VOICE: 保存的回复',
        sendVoice: async (_message, _content, options) => {
          voice.push(options);
          return voice.length === 1
            ? { status: 'pending', admitted: true }
            : { status: 'rejected', fallback: true, error: 'VOICE_TTS_FAILED' };
        },
        send: async (_message, _content, options) => {
          text.push(options);
          if (boundary === 'busy' && text.length === 1)
            throw Object.assign(Error('definite pre-admission refusal'), { code: 'SENDER_BUSY' });
          if (options.receiptOnly) return { status: admitted ? 'confirmed' : 'unconfirmed' };
          assert.equal(admitted, false);
          admitted = true;
          return { status: 'pending', admitted: true };
        },
      });
      t.after(() => engine.stop());
      return engine;
    };
    let buffer = f.buffer;
    let engine = make(buffer);
    if (boundary !== 'busy') {
      const remember = buffer.rememberReply.bind(buffer);
      t.mock.method(buffer, 'rememberReply', (conversation, item) => {
        remember(conversation, item);
        if (!interrupted && item.parts?.[0]?.voiceFallback) {
          interrupted = true;
          engine.stop();
          throw Error('simulated stop before the fallback RPC');
        }
      });
    }
    engine.receive(message('approved-fallback'));
    if (boundary !== 'busy') {
      await until(() => interrupted && !engine.running.has(key));
      assert.equal(text.length, 0);
      buffer = new MessageBuffer(buffer.file);
      if (boundary === 'revoked grant') {
        wechat.rosterGrants = { [key]: 'replacement-grant' };
        save();
      }
      engine = make(buffer);
      engine.replay(key);
    }
    await until(() => voice.length === 2 && buffer.pendingReplies.size === 0 && !engine.running.has(key));
    assert.deepEqual(
      voice.map(call => call.receiptOnly),
      [false, true],
    );
    if (boundary === 'revoked grant') {
      assert.deepEqual(text, []);
      assert.equal(admitted, false);
      return;
    }
    assert.deepEqual(
      text.map(call => call.receiptOnly),
      boundary === 'busy' ? [false, false, true] : [false, true],
    );
    const fallbackId = crypto
      .createHash('sha256')
      .update(voice[0].deliveryId + '\0voice-fallback')
      .digest('hex');
    assert.ok(text.every(call => call.deliveryId === fallbackId));
    assert.equal(buffer.findReplyPart(key, voice[0].deliveryId)?.delivery_status, 'confirmed');
  });
}

test('a lost text fallback acknowledgement reconciles the original native job', async t => {
  const f = fixture(t);
  const run = voiceEngine(f, {
    sendVoice: () => ({ status: 'rejected', fallback: true, error: 'VOICE_TTS_FAILED' }),
  });
  t.after(() => run.engine.stop());
  const accountRef = 'b'.repeat(64);
  const identity = { account: 'fixture' };
  const calls = [];
  const createTime = Math.floor(Date.now() / 1000) - 5;
  let original;
  const adapter = {
    accountRef,
    project: { wechat: {} },
    targetsSending: new Set(),
    textDeliveries: new TextDeliveryStore(path.join(f.dir, 'native-attempts')),
    status: { confirmed_sends: 0 },
    checkNative: async () => identity,
    receiptAccount: () => ({ ...identity, accountRef }),
    allowed: () => true,
    reload() {},
    async dispatchDesktop(operation, payload) {
      calls.push('admit');
      assert.equal(original, undefined);
      original = {
        operation,
        deliveryId: payload.deliveryId,
        admitted: true,
        state: 'confirmed',
        confirmed: true,
        receipt: { source: 'wechat-server-id', sourceShard: 'b'.repeat(64), localId: '1', serverId: '301', createTime },
      };
      throw Error('simulated lost desktop acknowledgement');
    },
    desktopSender: {
      async request(operation, scope) {
        calls.push(operation);
        assert.equal(scope.deliveryId, original.deliveryId);
        assert.equal(scope.accountRef, accountRef);
        return original;
      },
    },
  };
  run.engine.send = (_message, text, options) =>
    deliverDesktopMessage(adapter, { kind: 'private', target: '123', text, ...options }, async () => ({
      operation: 'text',
      body: { text },
    }));
  run.engine.receive(message('fallback-lost-acknowledgement'));
  await until(() => run.voiced.length === 1 && f.buffer.pendingReplies.size === 0 && !run.engine.running.has(key));
  assert.deepEqual(calls, ['admit', 'lookup']);
  assert.equal(adapter.status.confirmed_sends, 1);
  const recorded = f.buffer.findReplyPart(key, run.voiced[0].deliveryId);
  assert.equal(recorded?.delivery_status, 'confirmed');
  assert.equal(recorded.timestamp, createTime);
  assert.equal(
    recorded.readerOrder,
    String(createTime).padStart(20, '0') + '-' + '1'.padStart(20, '0') + '-' + 'b'.repeat(64),
  );
});

test('a slow voice uses one submission and follows its original ID until confirmed', async t => {
  const f = fixture(t),
    run = voiceEngine(f, { sendVoice: n => ({ status: n < 5 ? 'pending' : 'confirmed' }) });
  t.after(() => run.engine.stop());
  run.engine.receive(message('slow-voice'));
  await until(() => run.voiced.length === 5 && f.buffer.pendingReplies.size === 0);
  assert.deepEqual(
    run.voiced.map(x => x.receiptOnly),
    [false, true, true, true, true],
  );
  assert.equal(new Set(run.voiced.map(x => x.deliveryId)).size, 1);
  assert.deepEqual(
    f.buffer
      .recent(key)
      .filter(x => x.outgoing)
      .map(x => x.delivery_status),
    ['confirmed'],
  );
});

for (const format of ['text', 'quote', 'voice', 'voice fallback']) {
  test('a confirmed ' + format + ' receipt survives a restart before history is written', async t => {
    const { buffer } = fixture(t);
    const msg = message('history-interrupted');
    const deliveryId = 'c'.repeat(64);
    const result = {
      decision: 'RESPOND',
      text: 'saved reply',
      ...(format.startsWith('voice') ? { mode: 'voice' } : {}),
      ...(format === 'quote' ? { quoteEventId: 'd'.repeat(64) } : {}),
    };
    const parts = replyDeliveryParts(result, deliveryId);
    if (format === 'voice fallback') parts[0].voiceFallback = true;
    buffer.rememberReply(key, {
      message: msg,
      throughId: buffer.append(msg).id,
      deliveryId,
      result,
      parts,
      sending: true,
    });
    const calls = [];
    const deliver = async (_target, _text, options) => {
      calls.push(options);
      return { status: 'confirmed' };
    };
    const make = current => {
      const engine = new SocialEngine({
        buffer: current,
        batchMs: 1,
        decide: () => assert.fail('keep the original reply'),
        send: format === 'voice' ? () => assert.fail('voice must not become text') : deliver,
        sendVoice: format === 'voice' ? deliver : () => assert.fail('do not synthesize again'),
      });
      t.after(() => engine.stop());
      return engine;
    };
    const first = make(buffer);
    t.mock.method(buffer, 'recordReplyPart', () => {
      first.stop();
      throw new Error('simulated interruption before history was written');
    });
    first.replay(key);
    await until(() => calls.length === 1 && !first.running.has(key));

    const restored = new MessageBuffer(buffer.file);
    const resumed = make(restored);
    resumed.replay(key);
    await until(() => restored.pendingReplies.size === 0 && !resumed.running.has(key));
    assert.deepEqual(
      calls.map(call => [call.deliveryId, call.receiptOnly]),
      [
        [calls[0].deliveryId, false],
        [calls[0].deliveryId, true],
      ],
    );
    assert.equal(restored.findReplyPart(key, deliveryId)?.delivery_status, 'confirmed');
  });
}

for (const [format, failure, admitted, restart] of [
  ['text', 'busy', true, false],
  ['quote', 'timeout', true, true],
  ['voice', 'busy', true, false],
  ['voice', 'timeout', true, false],
  ['voice', 'busy', false, false],
]) {
  test(`receipt retries keep only confirmed desktop handoffs, ${format}, ${failure}, admitted=${admitted}`, async t => {
    const f = fixture(t);
    const msg = message('known-admission');
    const row = f.buffer.append(msg);
    const deliveryId = 'c'.repeat(64);
    const quoteEventId = format === 'quote' ? 'd'.repeat(64) : undefined;
    const result = {
      decision: 'RESPOND',
      text: 'fixture reply',
      ...(format === 'voice' ? { mode: 'voice' } : {}),
      ...(quoteEventId ? { quoteEventId } : {}),
    };
    f.buffer.rememberReply(key, {
      message: msg,
      throughId: row.id,
      deliveryId,
      result,
      parts: replyDeliveryParts(result, deliveryId),
      sending: true,
    });
    const calls = [];
    const deliver = async (_target, _text, options) => {
      calls.push(options);
      if (calls.length === 1) return { status: 'pending', ...(admitted ? { admitted: true } : {}) };
      if (calls.length <= 4) {
        if (admitted && calls.length === 4)
          throw Object.assign(Error('backend unavailable'), { code: 'BACKEND_UNAVAILABLE' });
        if (failure === 'busy') throw Object.assign(Error('receipt budget busy'), { code: 'SENDER_BUSY' });
        throw Error('OneBot action timeout: receipt query');
      }
      return { status: 'confirmed' };
    };
    const make = buffer => {
      const engine = new SocialEngine({
        buffer,
        batchMs: 1,
        privateMinIntervalMs: 0,
        minIntervalMs: 0,
        deliveryRetry: { receiptDelayMs: restart ? 40 : 5, maxBusyRetries: 2, busyDelayMs: 1 },
        decide: () => assert.fail('keep the original reply'),
        send: format === 'voice' ? () => assert.fail('voice must not become text') : deliver,
        sendVoice: format === 'voice' ? deliver : undefined,
        voiceReplyFor: async () => format === 'voice',
      });
      t.after(() => engine.stop());
      engine.replay(key);
      return engine;
    };
    let buffer = f.buffer;
    let engine = make(buffer);
    if (restart) {
      await until(() => buffer.pendingReplies.get(key)?.parts[0].desktopPending && !engine.running.has(key));
      engine.stop();
      buffer = new MessageBuffer(path.join(f.dir, 'messages.json'));
      assert.equal(buffer.pendingReplies.get(key).parts[0].desktopPending, true);
      engine = make(buffer);
    }
    await until(() => buffer.pendingReplies.size === 0 && !engine.running.has(key));
    const sent = buffer.recent(key).find(item => item.delivery_id === deliveryId);
    assert.equal(sent?.delivery_status, admitted ? 'confirmed' : undefined);
    assert.deepEqual(
      calls.map(call => call.receiptOnly),
      admitted ? [false, true, true, true, true] : [false, true, true, true],
    );
    assert.equal(
      calls.every(call => call.deliveryId === deliveryId && call.quoteEventId === quoteEventId),
      true,
    );
  });
}

test('a text fallback gets its own delivery and never inherits a voice handoff', async t => {
  const f = fixture(t);
  const run = voiceEngine(f, {
    sendVoice: n => (n === 1 ? { status: 'pending', admitted: true } : { status: 'rejected', fallback: true }),
  });
  const textCalls = [];
  run.engine.send = async (_target, _text, options) => {
    textCalls.push(options);
    if (textCalls.length === 1) throw Error('OneBot action timeout: sending text fallback');
    return { status: 'confirmed' };
  };
  t.after(() => run.engine.stop());
  run.engine.receive(message('voice-rejected-after-admission'));
  await until(() => run.voiced.length >= 2 && f.buffer.pendingReplies.size === 0 && !run.engine.running.has(key));
  assert.equal(textCalls.length, 1);
  assert.equal(textCalls[0].receiptOnly, false);
  assert.notEqual(textCalls[0].deliveryId, run.voiced[0].deliveryId);
});

test('a persisted long submitted voice part only re-checks its receipt after restart', async t => {
  const f = fixture(t),
    msg = message('voice-restart');
  f.buffer.append(msg);
  const throughId = f.buffer.unread(key)[0].id,
    deliveryId = 'f'.repeat(64);
  const text = '重启前已提交的语音。'.repeat(150);
  const result = { decision: 'RESPOND', mode: 'voice', text },
    parts = replyDeliveryParts(result, deliveryId);
  parts[0].state = 'submitted';
  f.buffer.rememberReply(key, { result, parts, throughId, deliveryId, message: msg, sending: true });
  const restored = new MessageBuffer(path.join(f.dir, 'messages.json')),
    run = voiceEngine(f, { buffer: restored });
  t.after(() => run.engine.stop());
  run.engine.replay(key);
  await until(() => restored.pendingReplies.size === 0 && !run.engine.running.has(key));
  assert.equal(run.calls(), 0);
  assert.deepEqual(run.sent, []);
  assert.deepEqual(
    run.voiced.map(item => [item.text, item.deliveryId]),
    [[text, parts[0].deliveryId]],
  );
  assert.deepEqual(
    restored
      .recent(key)
      .filter(row => row.outgoing)
      .map(row => row.text),
    ['[语音] ' + text],
  );
});

test('without a voice-capable backend the prompt has no voice notice and RESPOND_VOICE is sent as text', async t => {
  const f = fixture(t),
    run = voiceEngine(f, { voiceAllowed: false, decide: () => 'RESPOND_VOICE: 只能打字。' });
  t.after(() => run.engine.stop());
  run.engine.receive(message('voice-off'));
  await until(() => run.sent.length === 1 && !run.engine.running.has(key));
  assert(!run.prompts[0].includes(SOCIAL_VOICE_NOTICE));
  assert.deepEqual(run.voiced, []);
  assert.equal(run.sent[0].text, '只能打字。');
  const plain = fixture(t),
    textRun = voiceEngine(plain, { decide: () => 'RESPOND: 普通文字回复' });
  t.after(() => textRun.engine.stop());
  textRun.engine.receive(message('text-turn'));
  await until(() => textRun.sent.length === 1 && !textRun.engine.running.has(key));
  assert.deepEqual([textRun.sent[0].text, textRun.voiced.length], ['普通文字回复', 0]);
});

test('the 12000-character assistant budget fits the desktop and survives an outbox restart', t => {
  const text = 'x'.repeat(12000);
  const result = parseSocialDecision('RESPOND: ' + text, {}, { maxChars: text.length, maxTextParts: 2 });
  assert.equal(result.decision, 'RESPOND');
  assert.deepEqual(
    result.textParts.map(part => part.length),
    [10000, 2000],
  );
  assert.equal(result.textParts.join(''), text);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-long-reply-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const buffer = new MessageBuffer(path.join(directory, 'messages.json'));
  const target = { ...message('long'), work_mode: 'assistant' };
  const row = buffer.append(target);
  const deliveryId = 'a'.repeat(64);
  const parts = replyDeliveryParts(result, deliveryId);
  buffer.rememberReply(key, { result, parts, deliveryId, throughId: row.id, message: target });
  const restored = new MessageBuffer(buffer.file).pendingReplies.get(key);
  assert.deepEqual(restored.result, result);
  assert.deepEqual(restored.parts, parts);
  const quoted = parseSocialDecision(
    'RESPOND: [QUOTE:Q1] ' + text,
    {},
    {
      maxChars: text.length,
      quoteRefs: { Q1: 'a'.repeat(64) },
    },
  );
  assert.equal(quoted.text, 'x'.repeat(9999) + '…');
  assert.equal(quoted.quoteEventId, 'a'.repeat(64));
});
