import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WechatOneBot } from './wechat-onebot.mjs';
import { normalizeOneBotEvent } from '../components/qq-bridge/src/onebot/normalize.js';
import { VoiceIngress } from '../components/qq-bridge/src/core/voice-ingress.js';
import { nativeQuoteKind } from '../packages/dsh-social-bridge-plugin/native-quote-source.mjs';

test('Reader media fixtures exercise real codecs, forwarded quotes and account cache layouts', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const file = path.join(root, 'config/wechatagent.json');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {};
  const python = process.env.WECHATAGENT_TEST_PYTHON ?? config.runtime?.python ?? 'python';
  const result = spawnSync(python, ['-B', path.join(root, 'scripts/test-received-video.py')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 90000,
    windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
});

test('video quote candidates keep their type without audio or frames', () => {
  const adapter = { reload() {}, allowed: () => true, ownWxid: 'self' };
  for (const media of [{ attachmentUnavailable: true }, { image: { id: 'a'.repeat(64) } }]) {
    const event = WechatOneBot.prototype.incoming.call(adapter, {
      event: 'message.new',
      type: 43,
      rawid: 'b'.repeat(64),
      sessionId: 'peer',
      talkerId: 'peer',
      content: '[视频]',
      ...media,
    });
    const message = normalizeOneBotEvent('wechat', 'wechat-onebot', event);
    assert.equal(nativeQuoteKind(message), 'video');
    assert.equal(message.contextOnly, undefined);
    assert.equal(message.attachmentUnavailable, media.attachmentUnavailable);
  }
});

test('silent videos retain the verified duration and describe absent audio without a transcription request', () => {
  const adapter = { reload() {}, allowed: () => true, ownWxid: 'self' };
  const event = WechatOneBot.prototype.incoming.call(adapter, {
    event: 'message.new',
    type: 43,
    rawid: 'b'.repeat(64),
    sessionId: 'peer',
    talkerId: 'peer',
    content: '[视频]',
    image: { id: 'a'.repeat(64) },
    videoPlayback: { durationSeconds: 2, audioPresent: false },
  });
  const message = normalizeOneBotEvent('wechat', 'wechat-onebot', event);
  assert.match(message.text, /时长 2.00 秒。没有音轨/);
  assert.equal(message.images.length, 1);
  assert.equal(message.voice, undefined);
});

test('forwarded media notes preserve image, video and voice captions through model preparation', async () => {
  const bridge = { reload() {}, allowed: () => true, ownWxid: 'self' };
  const ids = ['a', 'b', 'c'].map(ch => ch.repeat(64));
  const caption = '😀'.repeat(780);
  const event = WechatOneBot.prototype.incoming.call(bridge, {
    event: 'message.new',
    type: 49,
    rawid: 'forwarded',
    sessionId: 'peer',
    talkerId: 'peer',
    content: '[合并转发聊天记录]',
    forwardedRecord: {
      version: 1,
      title: '说明',
      items: [
        { kind: '2', sender: 'A', time: '', depth: 0, text: '[图片，未提供图片内容] 维修前照片' },
        { kind: '4', sender: 'B', time: '', depth: 0, text: '[视频，未提供视频内容] ' + caption },
        { kind: '3', sender: 'C', time: '', depth: 0, text: '[语音，未转写] 现场语音' },
      ],
    },
    forwardAttachments: {
      images: [
        { index: 0, id: ids[0] },
        { index: 1, id: ids[1] },
      ],
      videos: { 1: { durationSeconds: 10, audioPresent: false } },
      voices: [{ index: 2, id: ids[2] }],
    },
  });
  const message = normalizeOneBotEvent('wechat', 'wechat-onebot', event);
  const ingress = new VoiceIngress({ recognize: async () => ({ ok: true, text: '测试转写' }) });
  try {
    const prepared = await ingress.push(message);
    const [photo, video, voice] = prepared.forwardedRecord.items;
    assert.match(photo.text, /^维修前照片\n\[历史附件/);
    assert(video.text.startsWith(caption));
    assert([...video.text].length <= 801);
    assert.match(voice.text, /^现场语音\n.*测试转写/);
    assert.equal(prepared.forwardedRecord.truncated, true);
  } finally {
    ingress.stop();
  }
});

test('a voice reference with no declared duration still reaches recognition', async () => {
  const adapter = { reload() {}, allowed: () => true, ownWxid: 'self' };
  const id = 'a'.repeat(64);
  const event = WechatOneBot.prototype.incoming.call(adapter, {
    event: 'message.new',
    type: 34,
    rawid: 'b'.repeat(64),
    sessionId: 'peer',
    talkerId: 'peer',
    content: '[语音]',
    voice: { id },
  });
  const message = normalizeOneBotEvent('wechat', 'wechat-onebot', event);
  const ingress = new VoiceIngress({
    recognize: async row => {
      assert.equal(row.voice.id, id);
      return { ok: true, text: 'fixture transcript' };
    },
    deliver: row => row.text,
  });
  try {
    assert.match(await ingress.push(message), /fixture transcript/);
  } finally {
    ingress.stop();
  }
});

test('forwarded quotes retain their reply while images and audio remain historical attachments', async () => {
  const bridge = { reload() {}, allowed: () => true, ownWxid: 'self' };
  const id = 'd'.repeat(64);
  const payload = {
    event: 'message.new',
    type: 49,
    rawid: 'quoted-record',
    sessionId: 'peer',
    talkerId: 'peer',
    content: '[合并转发聊天记录]',
    forwardedRecord: {
      version: 1,
      title: '引用',
      items: [{ kind: '1', sender: 'A', time: '', depth: 0, text: '针对原图和音轨的回复\n[引用历史媒体]' }],
    },
    forwardAttachments: { images: [{ index: 0, id }], voices: [{ index: 0, id }] },
  };
  const message = normalizeOneBotEvent(
    'wechat',
    'wechat-onebot',
    WechatOneBot.prototype.incoming.call(bridge, payload),
  );
  assert.equal(message.images[0].id, id);
  assert.equal(message.forwardedVoices[0].id, id);
  let delivered;
  const ingress = new VoiceIngress({
    recognize: async () => ({ ok: true, text: '历史转写' }),
    deliver: row => {
      delivered = row;
    },
  });
  await ingress.push(message);
  ingress.stop();
  const text = delivered.forwardedRecord.items[0].text;
  assert.match(text, /针对原图和音轨的回复/);
  assert.match(text, /被引用的历史消息/);
  assert.match(text, /历史转写/);
});

test('historical attachment transcripts stay on the correct forwarded items', async () => {
  const bridge = { reload() {}, allowed: () => true, ownWxid: 'self' };
  const row = (kind, sender) => ({ kind, sender, time: '', depth: 0, text: '[历史附件]' });
  const items = [row('2', 'A'), row('3', 'B'), row('4', 'C')];
  const refs = ['a', 'b', 'c'].map(c => c.repeat(64));
  const event = WechatOneBot.prototype.incoming.call(bridge, {
    event: 'message.new',
    type: 49,
    rawid: 'card',
    sessionId: 'peer',
    talkerId: 'peer',
    content: '[合并转发聊天记录]',
    forwardedRecord: { version: 1, title: '聊天记录', items },
    forwardAttachments: {
      images: [{ index: 0, id: refs[0] }],
      voices: [
        { index: 1, id: refs[1] },
        { index: 2, id: refs[2] },
      ],
    },
  });
  const message = normalizeOneBotEvent('wechat', 'wechat-onebot', event);
  const calls = [];
  let prepared;
  const ingress = new VoiceIngress({
    recognize: async row => {
      calls.push(row.voice.id);
      return row.voice.id === refs[1] ? { ok: true, text: '历史音频' } : { ok: false, code: 'VOICE_INPUT_FAILED' };
    },
    deliver: row => {
      prepared = row;
    },
  });
  await ingress.push(message);
  ingress.stop();
  assert.deepEqual(calls, refs.slice(1));
  assert.equal(prepared.text, '[合并转发聊天记录]');
  assert.deepEqual(prepared.images, [{ id: refs[0], forwardItem: 1 }]);
  assert.equal(prepared.forwardedRecord.items[1].sender, 'B');
  assert.match(prepared.forwardedRecord.items[1].text, /历史音轨自动转写.*历史音频/);
  assert.match(prepared.forwardedRecord.items[2].text, /未能转写/);
});

test('a video keeps its sampled images with an authorized audio transcript or an unavailable track', async () => {
  const bridge = { reload() {}, allowed: () => true, ownWxid: 'self' };
  const image = { id: 'a'.repeat(64) };
  const payload = {
    event: 'message.new',
    type: 43,
    talkerId: 'peer',
    sessionId: 'peer',
    rawid: 'fixture',
    content: '[视频：附图为按时间采样的画面]',
    image,
    voice: { id: 'c'.repeat(64), durationSeconds: 299.9 },
  };
  const event = WechatOneBot.prototype.incoming.call(bridge, payload);
  const message = normalizeOneBotEvent('wechat', 'wechat-onebot', event);
  assert.equal(message.voice.durationSeconds, 299.9);
  assert.deepEqual(message.images, [image]);
  assert.equal(message.voiceSource, 'video');
  for (const allowed of [true, false]) {
    let prepared;
    const ingress = new VoiceIngress({
      canRecognize: () => allowed,
      recognize: async () => ({ ok: true, text: '听到的内容' }),
      deliver: result => {
        prepared = result;
      },
    });
    await ingress.push(message);
    ingress.stop();
    assert.deepEqual(prepared.images, message.images);
    assert.ok(prepared.text.startsWith(payload.content));
    assert.match(prepared.text, allowed ? /音轨自动转写.*听到的内容/ : /音轨未转写/);
  }
  assert.equal(WechatOneBot.prototype.incoming.call(bridge, { ...payload, image: { id: 'bad' } }), null);
});
test('valid multilingual forwarded entries reach the bridge with their positions intact', () => {
  const python = process.env.WCA_MEDIA_TEST_PYTHON || 'python';
  const code = `
import json, sys
sys.path.insert(0, 'scripts')
from wechat_forwarded import parse_forwarded_record
xml = '<msg><appmsg><type>19</type><title>Forward</title><recorditem><recordinfo><datalist>' \
      + '<dataitem datatype="1"><sourcename>First</sourcename><datadesc>' + chr(0x1f600)*450 + '</datadesc></dataitem>' \
      + '<dataitem datatype="8"><sourcename>Second</sourcename><datadesc>' + 'A'*800 + '</datadesc></dataitem>' \
      + '</datalist></recordinfo></recorditem></appmsg></msg>'
print(json.dumps(parse_forwarded_record(xml)))`;
  const result = spawnSync(python, ['-B', '-c', code], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const bridge = { reload() {}, allowed: () => true, ownWxid: 'self' };
  const event = WechatOneBot.prototype.incoming.call(bridge, {
    event: 'message.new',
    type: 49,
    rawid: 'forwarded',
    sessionId: 'peer',
    talkerId: 'peer',
    content: '[合并转发聊天记录]',
    forwardedRecord: JSON.parse(result.stdout),
  });
  const record = normalizeOneBotEvent('wechat', 'wechat-onebot', event).forwardedRecord;
  assert.deepEqual(
    record.items.map(item => item.sender),
    ['First', 'Second'],
  );
  assert.equal([...record.items[0].text].length, 450);
  assert.equal(record.items[1].text.length, 801);
  assert.equal(record.truncated, true);
});
