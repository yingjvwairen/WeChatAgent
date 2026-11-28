import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WechatOneBot } from './wechat-onebot.mjs';
import { readerEvent } from './onebot-events.mjs';
import { normalizeOneBotEvent } from '../components/qq-bridge/src/onebot/normalize.js';
import { VoiceIngress } from '../components/qq-bridge/src/core/voice-ingress.js';
import { MessageBuffer } from '../components/qq-bridge/src/core/message-buffer.js';
import { SocialEngine } from '../components/qq-bridge/src/core/social-engine.js';
import { HistoryStore } from '../packages/dsh-social-bridge-plugin/history-store.mjs';

const id = 'a'.repeat(64);
function incoming(kind, media) {
  const bridge = { reload() {}, allowed: () => true, ownWxid: 'self' };
  const quoteReply = {
    version: 1,
    reply: '这说的是什么？',
    reference: {
      conversationId: '',
      senderId: 'peer',
      senderName: 'P',
      messageId: '1234',
      time: '100',
      kind,
      text: '[附件]',
      unavailable: true,
    },
  };
  const event = WechatOneBot.prototype.incoming.call(bridge, {
    event: 'message.new',
    type: 49,
    talkerId: 'peer',
    sessionId: 'peer',
    content: quoteReply.reply,
    rawid: '123',
    quoteReply,
    quotedMedia: media,
  });
  return normalizeOneBotEvent('wechat', 'wechat-onebot', event);
}
test('a bound quoted image remains attached to a historical speaker and keeps the new reply text', () => {
  const message = incoming('3', { kind: 'image', id });
  assert.deepEqual(message.images, [{ id, quoted: true }]);
  assert.equal(message.text, '这说的是什么？');
  assert.equal(message.quoteReply.reference.unavailable, false);
  assert.match(message.quoteReply.reference.text, /历史消息/);
  assert.deepEqual(incoming('34', { kind: 'image', id }).images, []);
});
test('quoted voice uses the chat voice recognizer and attributes the transcript to the historical speaker', async () => {
  const message = incoming('34', { kind: 'voice', id, durationSeconds: 2 });
  const delivered = [];
  const ingress = new VoiceIngress({
    recognize: async () => ({ ok: true, text: '原语音' }),
    deliver: row => delivered.push(row),
  });
  await ingress.push(message);
  ingress.stop();
  assert.equal(delivered[0].text, message.text);
  assert.equal(delivered[0].quoteReply.reply, message.text);
  assert.match(delivered[0].quoteReply.reference.text, /历史语音自动转写.*原语音/);
});
test('quoted video frames and audio stay with the historical message', async () => {
  const message = incoming('43', { kind: 'video', id, voice: { id: 'b'.repeat(64), durationSeconds: 2 } });
  const delivered = [];
  const ingress = new VoiceIngress({
    recognize: async () => ({ ok: true, text: '历史音轨' }),
    deliver: row => delivered.push(row),
  });
  await ingress.push(message);
  ingress.stop();
  assert.deepEqual(delivered[0].images, [{ id, quoted: true }]);
  assert.match(delivered[0].quoteReply.reference.text, /历史视频音轨.*历史音轨/);
  assert.equal(delivered[0].text, message.text);
});

test(
  'forwarded images identify the exact historical entries in current and reopened background messages',
  { timeout: 5000 },
  async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forwarded-images-'));
    const archive = new HistoryStore(root, 'c'.repeat(64));
    const room = 'fixture-room@chatroom',
      key = 'wechat:group:' + room;
    const before = Math.floor(Date.now() / 1000) - 2;
    const openBuffer = () => new MessageBuffer(path.join(root, 'inbox.json'), { archive });
    const message = (index, mediaId, current) =>
      normalizeOneBotEvent(
        'wechat',
        'fixture',
        readerEvent(
          {
            event: 'message.new',
            type: 49,
            sessionId: room,
            talkerId: 'peer',
            rawid: current ? 'current' : 'background',
            timestamp: before + Number(current),
            content: '[合并转发聊天记录]',
            mentionsSelf: current,
            forwardedRecord: {
              version: 1,
              title: '历史聊天',
              items: ['甲', '乙'].map(sender => ({ sender, time: '', kind: '1', depth: 0, text: '引用图片' })),
            },
            forwardAttachments: { images: [{ index, id: mediaId }], voices: [] },
          },
          { ownWxid: 'self', allowed: () => true },
        ),
      );
    const { promise, resolve } = Promise.withResolvers();
    const options = {
      mode: 'mention',
      batchMs: 1,
      decide: async (_key, prompt, details) => {
        resolve({ prompt, details });
        return 'SILENT';
      },
      send: () => assert.fail('no live sends'),
    };
    const initial = new SocialEngine({ ...options, buffer: openBuffer() });
    const first = message(0, id, false);
    initial.receive(first);
    initial.stop();
    assert.deepEqual(archive.windowRows(key, { recentMessages: 1 })[0].images, [{ id, forwardItem: 1 }]);

    const current = new SocialEngine({ ...options, buffer: openBuffer() });
    t.after(() => {
      current.stop();
      archive.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const currentId = 'b'.repeat(64);
    current.receive(message(1, currentId, true));
    const { prompt, details } = await promise;
    assert.match(prompt, /乙: \[附图 I1\] 引用图片/);
    assert.doesNotMatch(prompt, /甲: \[附图 I1\]/);
    assert.match(prompt, /"forwardedImages":\[\{"item":1,"images":\["I2"\],"speaker":"甲"\}\]/);
    assert.deepEqual(details.images, [
      { id: currentId, forwardItem: 2 },
      { id, forwardItem: 1 },
    ]);
  },
);
