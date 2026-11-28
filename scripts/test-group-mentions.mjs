import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeOneBotEvent } from '../components/qq-bridge/src/onebot/normalize.js';
import { isDirectMention, SocialEngine } from '../components/qq-bridge/src/core/social-engine.js';
import { MessageBuffer } from '../components/qq-bridge/src/core/message-buffer.js';
import { WechatOneBot } from './wechat-onebot.mjs';

test('group mention metadata takes precedence over typed nicknames', () => {
  const adapter = { reload() {}, allowed: () => true, ownWxid: 'self', project: { account: { nicknames: ['Bot'] } } };
  const payload = {
    event: 'message.new',
    sessionId: 'room@chatroom',
    talkerId: 'friend',
    type: 1,
    content: 'hello @Bot',
  };
  const mentions = data =>
    WechatOneBot.prototype.incoming
      .call(adapter, { ...payload, ...data })
      .message.filter(segment => segment.type === 'at')
      .map(segment => segment.data.id);
  assert.deepEqual(mentions({}), []);
  assert.deepEqual(mentions({ mentionsSelf: false }), []);
  assert.equal(mentions({ content: 'hello', mentionsSelf: true }).length, 1);
  assert.deepEqual(mentions({ mentionsSelf: false, mentionsAll: true }), ['all']);
});

test('a native all-members mention wakes a long-running mention-only WeChat chat once', { timeout: 10000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-mention-'));
  const file = path.join(root, 'messages.json'),
    buffer = new MessageBuffer(file);
  const model = Promise.withResolvers();
  let calls = 0;
  const engine = new SocialEngine({
    buffer,
    mode: 'mention',
    batchMs: 1,
    minIntervalMs: 0,
    stickerPolicyFor: () => ({ enabled: false }),
    decide: async (_key, prompt, metadata) => {
      calls++;
      model.resolve({ prompt, metadata });
      return 'SILENT';
    },
    send: async () => {
      throw Error('unexpected send');
    },
  });
  t.after(() => {
    engine.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const adapter = { reload() {}, allowed: () => true, ownWxid: 'self' };
  const input = (id, extra = {}) =>
    normalizeOneBotEvent(
      'wechat',
      'wechat-onebot',
      WechatOneBot.prototype.incoming.call(adapter, {
        event: 'message.new',
        sessionId: 'room@chatroom',

        talkerId: 'member',
        type: 1,
        rawid: id,
        content: '@所有人 例会',
        ...extra,
      }),
    );
  const key = 'wechat:group:room@chatroom';
  for (let i = 0; i < buffer.maxPerChat; i++)
    engine.receive(input(i.toString(16).padStart(64, '0'), { content: `群聊背景 ${i}` }));
  const image = { id: 'a'.repeat(64) };
  engine.receive({ ...input('a'.repeat(64), { content: '最新背景 [图片]' }), images: [image] });
  assert.equal(calls, 0);
  assert.equal(buffer.unread(key).length, 0);
  assert.equal(buffer.chats.get(key).length, buffer.maxPerChat);
  const all = input('b'.repeat(64), { mentionsAll: true });
  assert.equal(isDirectMention(all), true);
  assert.equal(isDirectMention({ ...all, platform: 'qq' }), false);
  assert.equal(isDirectMention({ ...all, kind: 'private' }), false);
  engine.receive(all);
  const { prompt, metadata } = await model.promise;
  assert.match(prompt, /全体提醒/);
  assert.match(prompt, /最新背景/);
  assert.deepEqual(metadata.images, [image]);
  while (engine.running.size) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  assert.equal(new MessageBuffer(file).recent('wechat:group:room@chatroom').at(-1).direct_mention, true);
  const both = input('c'.repeat(64), { mentionsSelf: true, mentionsAll: true });
  assert.equal(isDirectMention(both), true);
  assert.equal(isDirectMention({ ...input('d'.repeat(64)), segments: [{ type: 'at', data: { qq: '999' } }] }), false);
});

test('withdrawn queued input cannot hide the next mention under a fresh chat grant', { timeout: 5000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-mention-grant-'));
  const buffer = new MessageBuffer(path.join(root, 'messages.json'), { maxPerChat: 10 });
  const model = Promise.withResolvers();
  const engine = new SocialEngine({
    buffer,
    mode: 'mention',
    deliveryControls: { scope: () => 'current' },
    stickerPolicyFor: () => ({ enabled: false }),
    decide: async (_key, prompt) => {
      model.resolve(prompt);
      return 'SILENT';
    },
    send: () => assert.fail('unexpected send'),
  });
  t.after(() => {
    engine.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const message = {
    platform: 'wechat',
    kind: 'group',
    conversation_id: 'room@chatroom',
    sender_id: 'member',
    self_id: 'owner',
    mentionTarget: 'self',
    direct_mention: true,
    readerGrant: 'withdrawn',
  };
  for (let i = 0; i < buffer.maxPerChat; i++)
    buffer.append({ ...message, message_id: String(i), text: 'withdrawn input' });
  engine.receive({ ...message, readerGrant: 'current', message_id: 'current', text: 'new authorized mention' });
  const prompt = await model.promise;
  assert.match(prompt, /new authorized mention/);
  assert.doesNotMatch(prompt, /withdrawn input/);
  const archived = new MessageBuffer(buffer.file).findIncoming({
    ...message,
    message_id: String(buffer.maxPerChat - 1),
  });
  assert.equal(archived?.reply_skip_reason, 'conversation_grant_changed');
});

test('Realtime honors all-members mentions in social chats and leaves assistant chats to DSH', () => {
  const adapter = Object.create(WechatOneBot.prototype);
  const wechat = { whitelist: { groups: ['room@chatroom'], private: [] }, wake_mode: 'mention' };
  const key = 'wechat:group:room@chatroom';
  Object.assign(adapter, {
    ownWxid: 'self',
    project: { wechat },
    reload() {},
    allowed: () => true,
    voiceSend: { synthesis: { candidates: () => [{ id: 'voice' }] } },
  });
  function trigger(extra) {
    const payload = {
      event: 'message.new',
      type: 1,
      rawid: 'a'.repeat(64),
      sessionId: 'room@chatroom',

      talkerId: 'member',
      content: '@所有人 开会',
      ...extra,
    };
    adapter.accountRef = 'a'.repeat(64);
    const input = adapter.realtimeInput(payload, adapter.incoming(payload), {
      account: adapter.accountRef,
      grant: 'legacy',
      rawid: payload.rawid,
    });
    return !!input && adapter.realtimePermitted(input)();
  }
  assert.equal(trigger({}), false);
  assert.equal(trigger({ mentionsAll: true }), true);
  assert.equal(trigger({ mentionsAll: true, contextOnly: true }), false);
  wechat.workModes = { [key]: 'assistant' };
  assert.equal(trigger({ mentionsAll: true }), false);
  wechat.assistant = { administrators: ['member'] };
  assert.equal(trigger({ mentionsAll: true }), false);
  wechat.workModes[key] = 'social';
  assert.equal(trigger({ mentionsAll: true }), true);
});
