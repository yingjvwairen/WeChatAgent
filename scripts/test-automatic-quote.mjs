import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SocialEngine } from '../components/qq-bridge/src/core/social-engine.js';
import { MessageBuffer } from '../components/qq-bridge/src/core/message-buffer.js';
import { WechatOneBotAdapter } from '../components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js';
import { normalizeOneBotEvent } from '../components/qq-bridge/src/onebot/normalize.js';
import { HistoryStore } from '../packages/dsh-social-bridge-plugin/history-store.mjs';
import { bindHistory } from '../packages/dsh-social-bridge-plugin/history-runtime.mjs';
import { quotedHistoryMatches } from '../packages/dsh-social-bridge-plugin/native-quote-source.mjs';
import { parseSocialDecision } from '../components/qq-bridge/src/core/decision-format.js';
import { readerEvent } from './onebot-events.mjs';

const key = 'wechat:private:123';
const sourceId = 'a'.repeat(64);
const incoming = (overrides = {}) => ({
  platform: 'wechat',
  kind: 'private',
  conversation_id: '123',
  sender_id: '456',
  self_id: '99',
  message_id: sourceId,
  text: '周六一起吃面',
  timestamp: Date.now() / 1000,
  ...overrides,
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-autoquote-'));
  const engines = [];
  const stores = [];
  t.after(() => {
    for (const engine of engines) engine.stop();
    for (const store of stores) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const bufferFile = path.join(root, 'messages.json');
  return {
    root,
    bufferFile,
    stores,
    engine(options) {
      const engine = new SocialEngine({
        batchMs: 1,
        privateMinIntervalMs: 0,
        minIntervalMs: 0,
        maxPerMinute: 100,
        maxPerTenMinutes: 100,
        ...options,
      });
      engines.push(engine);
      return engine;
    },
  };
}

async function until(check) {
  for (let i = 0; i < 250; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('Quote fixture timed out');
}

test('live notices and drained offline context reach the next decision in source order', async t => {
  const f = fixture(t),
    buffer = new MessageBuffer(f.bufferFile),
    prompts = [];
  const engine = f.engine({
    buffer,
    decide: async (_key, prompt) => {
      prompts.push(prompt);
      return 'SILENT';
    },
    send: async () => assert.fail('No send expected'),
  });
  const stamp = Math.floor(Date.now() / 1000);
  const message = (id, text, ordinal, fields = {}) =>
    incoming({
      message_id: id.repeat(64),
      timestamp: stamp,
      text,
      readerGrant: 'g',
      readerOrder: String(stamp).padStart(20, '0') + '-' + String(ordinal).padStart(20, '0') + '-' + 'c'.repeat(64),
      ...fields,
    });
  engine.receive(message('a', 'fixture-notice', 1, { contextOnly: true }));
  engine.receive(message('b', 'fixture-live', 2));
  await until(() => prompts.length === 1 && !engine.running.has(key));
  assert.match(prompts[0], /fixture-notice/);
  engine.receive(message('c', 'fixture-second', 4, { readerReplay: 'context' }));
  engine.receive(message('d', 'fixture-first', 3, { readerReplay: 'context' }));
  engine.receive(message('e', 'fixture-wake', 5, { readerReplay: 'reply' }));
  await until(() => prompts.length === 2 && !engine.running.has(key));
  assert.match(prompts[1], /fixture-first[\s\S]+fixture-second/);
});

test('automatic recent quote reaches native reply segment without leaking the control marker', async t => {
  const f = fixture(t),
    buffer = new MessageBuffer(f.bufferFile),
    sent = [];
  const adapter = new WechatOneBotAdapter();
  adapter.server.action = async (action, params) => {
    sent.push({ action, params });
    return { data: { receipt: 'wechat-server-id' } };
  };
  const engine = f.engine({
    buffer,
    decide: async (_key, prompt, metadata) => {
      assert.match(prompt, /\[QUOTE:Q编号\]/);
      assert.match(prompt, /Q1/);
      assert(!prompt.includes(sourceId));
      assert.equal(metadata.allowHistoryQuote, true);
      return 'RESPOND: [QUOTE:Q1] 好，周六见。';
    },
    send: (target, text, options) =>
      adapter.sendText({ kind: target.kind, target: target.conversation_id, text, ...options }),
  });
  engine.receive(incoming());
  await until(() => sent.length === 1 && !engine.running.has(key));
  assert.deepEqual(sent[0].params.message, [
    { type: 'reply', data: { id: sourceId } },
    { type: 'text', data: { text: '好，周六见。' } },
  ]);
  assert.equal(buffer.recent(key).find(row => row.outgoing).text, '好，周六见。');
});

test('the model sends a quoted image as one native media message', async t => {
  const f = fixture(t),
    buffer = new MessageBuffer(f.bufferFile),
    sent = [];
  const stickerId = 'c'.repeat(64);
  const adapter = new WechatOneBotAdapter();
  adapter.server.action = async (action, params) => {
    sent.push({ action, params });
    return {
      data: {
        receipt: 'wechat-server-id',
        delivered: 'database-confirmed',
        media_type: 'wechat-image',
        imageContentMatch: 'source-md5',
      },
    };
  };
  const engine = f.engine({
    buffer,
    stickerChoicesFor: async () => [
      { id: stickerId, source: 'local-library', description: '示例图片', tags: ['图片'] },
    ],
    decide: async (_key, prompt) => {
      assert.match(prompt, /\[QUOTE:Q编号\] \[STICKER:S编号\]/);
      assert.match(prompt, /S1：/);
      return 'RESPOND: [QUOTE:Q1] [STICKER:S1]';
    },
    send: async () => assert.fail('The media has its own quote'),
    sendSticker: (target, id, options) =>
      adapter.sendSticker({ kind: target.kind, target: target.conversation_id, id, ...options }),
  });
  engine.receive(incoming({ text: '引用我这条消息并发一张图片' }));
  await until(() => sent.length === 1 && buffer.mediaReplies.size === 0);
  assert.deepEqual(sent[0].params.message, [
    { type: 'reply', data: { id: sourceId } },
    { type: 'wechat_sticker', data: { id: stickerId } },
  ]);
  assert.equal(buffer.recent(key).filter(row => row.outgoing).length, 1);
});

test('messages received before a group mention stay available for recent and historical quotes', async t => {
  const f = fixture(t);
  const store = new HistoryStore(f.root, 'b'.repeat(64));
  f.stores.push(store);
  const buffer = new MessageBuffer(f.bufferFile, { archive: store });
  const prompts = [];
  const engine = f.engine({
    buffer,
    mode: 'mention',
    decide: async (_key, prompt) => {
      prompts.push(prompt);
      return 'SILENT';
    },
    send: async () => assert.fail('No send expected'),
  });
  const group = { kind: 'group', conversation_id: 'test@chatroom', readerGrant: 'fixture-grant' };
  const groupKey = 'wechat:group:' + group.conversation_id;
  const original = incoming({ ...group, text: 'An earlier group message' });
  engine.receive(original);
  assert.equal(buffer.unread(groupKey).length, 0);
  assert.equal(engine.timers.size, 0);
  assert.equal(prompts.length, 0);

  engine.receive(incoming({ ...group, message_id: 'c'.repeat(64), mentionTarget: 'self', text: 'Please quote it' }));
  await until(() => prompts.length === 1 && !engine.running.has(groupKey));
  const [prompt] = prompts;
  const choices = JSON.parse(prompt.match(/<quote_candidates>(.*?)<\/quote_candidates>/s)[1]);
  assert.equal(choices[0].text, original.text);
  assert.match(prompt.slice(0, prompt.indexOf('<quote_candidates>')), /An earlier group message/);

  const turn = { allowHistoryQuote: true };
  const found = quotedHistoryMatches(store, groupKey, turn, store.search(groupKey, original.text));
  assert.equal(found.length, 1);
  assert.equal(turn.historyQuoteRefs[found[0].quoteRef], original.message_id);
});

test('current image slots and voice transcript labels identify consecutive quote candidates', async t => {
  const f = fixture(t),
    buffer = new MessageBuffer(f.bufferFile);
  const images = ['b'.repeat(64), 'c'.repeat(64)];
  const model = Promise.withResolvers();
  const engine = f.engine({
    buffer,
    decide: async (_key, prompt, metadata) => {
      model.resolve({ prompt, metadata });
      return 'SILENT';
    },
    send: () => assert.fail('silent'),
  });
  for (const [index, id] of images.entries()) {
    buffer.append(incoming({ message_id: String(index + 1).repeat(64), text: '[图片]', images: [{ id }] }));
  }
  engine.receive(incoming({ message_id: '3'.repeat(64), text: '[语音转写] hello', quoteKind: 'voice' }));
  const { prompt, metadata } = await model.promise;
  const choices = JSON.parse(prompt.match(/<quote_candidates>(.*?)<\/quote_candidates>/s)[1]);
  assert.deepEqual(
    choices.map(c => [c.ref, c.images, c.media]),
    [
      ['Q1', ['I1'], undefined],
      ['Q2', ['I2'], undefined],
      ['Q3', undefined, ['M1']],
    ],
  );
  assert.deepEqual(
    metadata.images.map(image => image.id),
    images,
  );
  assert.match(prompt, /\[M1\].*hello/);
});

test('a persisted quoted reply resumes after restart without a second model decision', async t => {
  const f = fixture(t),
    buffer = new MessageBuffer(f.bufferFile);
  let attempts = 0;
  const first = f.engine({
    buffer,
    decide: async () => 'RESPOND: [QUOTE:Q1] 好的',
    deliveryRetry: { busyDelayMs: 30000 },
    send: async () => {
      attempts++;
      throw Object.assign(Error('SENDER_BUSY'), { code: 'SENDER_BUSY' });
    },
  });
  first.receive(incoming());
  await until(() => attempts === 1 && !first.running.has(key));
  first.stop();
  const restored = new MessageBuffer(f.bufferFile),
    deliveries = [];
  assert.equal(restored.pendingReplies.get(key).parts[0].quoteEventId, sourceId);
  const next = f.engine({
    buffer: restored,
    decide: async () => {
      throw Error('Must resume the durable decision');
    },
    send: async (_target, text, options) => {
      deliveries.push({ text, ...options });
      return { delivered: 'database-confirmed' };
    },
  });
  next.replay(key);
  await until(() => deliveries.length === 1 && !next.running.has(key));
  assert.equal(deliveries[0].quoteEventId, sourceId);
  assert.equal(deliveries[0].text, '好的');
  assert.equal(restored.pendingReplies.size, 0);
});

test('historical quote tool labels flow through model metadata into automatic delivery', async t => {
  const f = fixture(t),
    store = new HistoryStore(f.root, 'b'.repeat(64));
  f.stores.push(store);
  fs.mkdirSync(path.join(f.root, 'config'));
  fs.writeFileSync(
    path.join(f.root, 'config/wechatagent.json'),
    JSON.stringify({
      wechat: {
        whitelist: { private: ['123'], groups: [] },
        history: { enabled: true },
      },
    }),
  );
  const oldId = store.append(key, { ...incoming(), outgoing: false, quoteKind: 'image' });
  store.append(key, { ...incoming({ message_id: 'c'.repeat(64) }), outgoing: false, contextOnly: true });
  store.append(key, { ...incoming({ message_id: 'd'.repeat(64) }), outgoing: true });
  store.append('wechat:private:999', { ...incoming({ message_id: 'e'.repeat(64) }), outgoing: false });
  const buffer = new MessageBuffer(f.bufferFile),
    deliveries = [];
  const engine = f.engine({
    buffer,
    decide: async (_key, _prompt, metadata) => {
      const turn = { controller: new AbortController(), allowHistoryQuote: metadata.allowHistoryQuote };
      let definition;
      const dispose = bindHistory(
        {
          tools: {
            register(value) {
              definition = value;
              return () => {};
            },
          },
        },
        store,
        f.root,
        key,
        () => turn,
        () => true,
      );
      try {
        const result = JSON.parse((await definition.execute({ query: '一起吃面' })).content);
        assert(!JSON.stringify(result).includes(sourceId));
        assert.deepEqual(
          result.matches.flatMap(row => (row.quoteRef ? [row.quoteRef] : [])),
          ['H' + oldId],
        );
        metadata.historyQuoteRefs = turn.historyQuoteRefs;
        return `RESPOND: [QUOTE:H${oldId}] 就按之前的约定。`;
      } finally {
        dispose();
      }
    },
    send: async (_target, text, options) => {
      deliveries.push({ text, ...options });
      return { delivered: 'database-confirmed' };
    },
  });
  engine.receive(incoming({ message_id: 'f'.repeat(64), text: '之前那件事还记得吗' }));
  await until(() => deliveries.length === 1 && !engine.running.has(key));
  assert.equal(deliveries[0].quoteEventId, sourceId);
});

test('system and unknown-card context is stored without waking the bot or becoming a quote candidate', async t => {
  const f = fixture(t),
    buffer = new MessageBuffer(f.bufferFile);
  let decisions = 0;
  const engine = f.engine({
    buffer,
    decide: async () => {
      decisions++;
      return 'SILENT';
    },
    send: async () => {
      throw Error('No send');
    },
  });
  const message = normalizeOneBotEvent(
    'wechat',
    {},
    {
      post_type: 'message',
      message_type: 'private',
      self_id: '99',
      user_id: '123',
      message_id: sourceId,
      message: [{ type: 'text', data: { text: '[系统通知] 对方撤回了一条消息' } }],
      wechatagent: { contextOnly: true, attachmentUnavailable: true, quoteKind: 'card' },
    },
  );
  engine.receive(message);
  assert.equal(buffer.recent(key).length, 1);
  assert.equal(buffer.recent(key)[0].contextOnly, true);
  assert.equal(buffer.recent(key)[0].attachmentUnavailable, true);
  assert.equal(buffer.recent(key)[0].quoteKind, undefined);
  assert.equal(buffer.unread(key).length, 0);
  assert.equal(engine.timers.size, 0);
  assert.equal(decisions, 0);
});

test('a WeChat system notice is evaluated in the assistant chat lane without starting a task', async t => {
  const f = fixture(t),
    buffer = new MessageBuffer(f.bufferFile),
    prompts = [];
  const engine = f.engine({
    buffer,
    workModeFor: () => 'assistant',
    assistantChatOnly: true,
    assistantBatchMs: 1,
    assistantAccess: (_key, message) => message.systemNotice === true,
    decide: async (_key, prompt, metadata) => {
      prompts.push({ prompt, metadata });
      return 'SILENT';
    },
    send: () => assert.fail('No send expected'),
  });
  const content = '[系统通知] 对方撤回了一条消息';
  const event = readerEvent(
    {
      event: 'message.new',
      type: 1,
      sessionId: '123',
      talkerId: 'wechat-system',
      sourceName: '会话联系人',
      rawid: sourceId,
      timestamp: Math.floor(Date.now() / 1000) - 1,
      content,
      contextOnly: true,
      systemNotice: true,
    },
    { ownWxid: '99', allowed: (kind, target) => kind === 'private' && target === '123' },
  );
  const notice = normalizeOneBotEvent('wechat', 'fixture', event);
  assert.equal(notice.conversation_name, '会话联系人');
  assert.equal(notice.sender_name, '微信系统');
  engine.receive(notice);
  assert.equal(buffer.recent(key).at(-1).systemNotice, true);
  await until(() => prompts.length === 1 && !engine.running.has(key));
  assert.ok(prompts[0].prompt.includes(content));
  assert.equal(prompts[0].metadata.assistantChatOnly, true);
  assert.equal(prompts[0].metadata.systemNotice, true);
  assert.deepEqual(prompts[0].metadata.files, []);
});

test('a group join notice enters reply judgment in mention-only mode', async t => {
  const f = fixture(t),
    buffer = new MessageBuffer(f.bufferFile),
    prompts = [];
  const engine = f.engine({
    buffer,
    mode: 'mention',
    decide: async (_key, prompt) => {
      prompts.push(prompt);
      return 'SILENT';
    },
    send: () => assert.fail('No send expected'),
  });
  const target = 'fixture@chatroom';
  const event = readerEvent(
    {
      event: 'message.new',
      type: 1,
      sessionId: target,
      talkerId: 'wechat-system',
      rawid: sourceId,
      content: '[系统通知] 新成员加入了群聊',
      contextOnly: true,
      systemNotice: true,
    },
    { ownWxid: '99', allowed: (kind, id) => kind === 'group' && id === target },
  );
  engine.receive(normalizeOneBotEvent('wechat', 'fixture', event));
  await until(() => prompts.length === 1 && !engine.running.has('wechat:group:' + target));
  assert.match(prompts[0], /新成员加入了群聊/);
});

test('unknown, nested and voice quote markers cannot reach a normal text send', () => {
  const options = { quoteRefs: { Q1: sourceId }, allowVoice: true };
  for (const output of [
    'RESPOND: [QUOTE:Q8] 好',
    'RESPOND: [QUOTE:Q1] [QUOTE:Q1] 好',
    'RESPOND_VOICE: [QUOTE:Q1] 好',
    'RESPOND: [QUOTE:Q1] [STICKER:S1]',
  ]) {
    assert.equal(parseSocialDecision(output, {}, options).decision, 'INVALID');
  }
});
