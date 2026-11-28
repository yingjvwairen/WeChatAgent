import { audioSegments } from '../packages/plugin-api/audio.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../optional-extensions/speech-synthesis/index.mjs';
import { waveFile, maximumSynthesisSeconds } from '../optional-extensions/speech-synthesis/lib/wav.mjs';
import modelFields from '../packages/speech-contract/local-model-fields.json' with { type: 'json' };
import { maxReplyChars } from './voice-synthesis.mjs';
import { featureConfigured } from '../packages/plugin-api/contract.mjs';
import { PluginRuntime } from '../packages/plugin-api/index.mjs';
import { WechatOneBot } from './wechat-onebot.mjs';
import { normalizeOneBotEvent } from '../components/qq-bridge/src/onebot/normalize.js';
import { VoiceIngress } from '../components/qq-bridge/src/core/voice-ingress.js';
import { MessageBuffer } from '../components/qq-bridge/src/core/message-buffer.js';
import { SocialEngine } from '../components/qq-bridge/src/core/social-engine.js';

const manifest = JSON.parse(
  fs.readFileSync(new URL('../optional-extensions/speech-synthesis/plugin.json', import.meta.url)),
);
const settings = {
  ...manifest.settings,
  endpoint: 'http://127.0.0.1:8000/v1',
  recognitionModel: 'default',
  recognitionEndpoint: 'http://127.0.0.1:8000/v1',
  apiKey: 'fixture',
  timeoutMs: 20000,
  voiceMode: 'separate',
};
const actions = new Map();
setup({ registerAction: action => actions.set(action.id, action) });
const id = 'a'.repeat(64);

function savedAudio(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admitted-audio-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'messages.json'),
    account = 'c'.repeat(64);
  const open = () => new MessageBuffer(file, { readerAccount: account });
  const message = {
    platform: 'wechat',
    kind: 'group',
    conversation_id: 'audio_room@chatroom',
    sender_id: 'wxid_member',
    self_id: 'wxid_self',
    message_id: 'voice-one',
    timestamp: 1700000000,
    voice: { id },
    text: '[语音，尚未转写]',
  };
  return { file, open, message, key: 'wechat:group:audio_room@chatroom' };
}

test(
  'a woken group turn can transcribe both offline and live background voice after reopening the buffer',
  { timeout: 5000 },
  async t => {
    const f = savedAudio(t),
      calls = [];
    const ingress = new VoiceIngress({
      recognize: async message => {
        calls.push(message.message_id);
        return { ok: true, text: '已转写-' + message.message_id };
      },
    });
    t.after(() => ingress.stop());
    const first = f.open();
    const options = {
      mode: 'mention',
      send: async () => {},
      prepareVoiceRows: (...args) => ingress.prepareRows(...args),
    };
    const engine = new SocialEngine({ ...options, buffer: first, decide: () => assert.fail('group did not wake') });
    engine.receive(f.message);
    const offline = {
      ...f.message,
      message_id: 'offline-voice',
      voice: { id: 'b'.repeat(64) },
      readerReplay: 'context',
    };
    engine.receive(offline);
    const disconnected = {
      ...f.message,
      work_mode: 'social',
      message_id: 'dsh-offline-voice',
      voice: { id: 'c'.repeat(64) },
    };
    first.append(disconnected, { skipReason: 'dsh_offline' });
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).readerMediaPins.ids, [
      id,
      offline.voice.id,
      disconnected.voice.id,
    ]);
    assert.deepEqual(calls, []);
    engine.stop();

    let resume;
    const prompt = new Promise(resolve => {
      resume = resolve;
    });
    const buffer = f.open();
    const reopened = new SocialEngine({
      ...options,
      buffer,
      decide: async (_key, text) => {
        resume(text);
        return 'SILENT';
      },
    });
    t.after(() => reopened.stop());
    reopened.receive({
      ...f.message,
      voice: undefined,
      message_id: 'wake',
      timestamp: f.message.timestamp + 1,
      text: '刚才说了什么？',
      mentionTarget: 'self',
    });
    const text = await prompt;
    assert.match(text, /已转写-voice-one/);
    assert.match(text, /已转写-offline-voice/);
    assert.match(text, /已转写-dsh-offline-voice/);
    assert.equal(calls.length, 3);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).readerMediaPins.ids, []);
  },
);

test('an interrupted write after recognition preserves the attempt and does not call the provider again', async t => {
  const f = savedAudio(t),
    buffer = f.open();
  const row = buffer.append(f.message);
  const update = buffer.updateVoice.bind(buffer);
  buffer.updateVoice = (...args) => {
    if (args[3]?.archive) throw Error('fixture write interrupted');
    return update(...args);
  };
  let calls = 0;
  const ingress = new VoiceIngress({
    recognize: async () => {
      calls++;
      assert.equal(f.open().findIncoming(f.message).voiceAttempted, true);
      return { ok: true, text: 'provider result' };
    },
  });
  t.after(() => ingress.stop());
  await assert.rejects(
    ingress.prepareRows(buffer, f.key, [row], () => true),
    /fixture write interrupted/,
  );
  const reopened = f.open(),
    restored = reopened.findIncoming(f.message);
  await ingress.prepareRows(reopened, f.key, [restored], () => true);
  assert.equal(calls, 1);
  assert.match(restored.text, /VOICE_INPUT_INTERRUPTED/);
  assert.equal(restored.voice, undefined);
});

test('a transcription is discarded if the speech plugin is withdrawn before the buffer commits it', async t => {
  const f = savedAudio(t);
  const buffer = f.open();
  const row = buffer.append(f.message);
  const diagnosing = Promise.withResolvers();
  const resume = Promise.withResolvers();
  let enabled = true;
  let calls = 0;
  const ingress = new VoiceIngress({
    canRecognize: () => enabled,
    recognize: async () => {
      calls++;
      return { ok: true, text: 'uncommitted fixture transcript' };
    },
    onResult: async () => {
      diagnosing.resolve();
      await resume.promise;
    },
  });
  t.after(() => ingress.stop());
  const work = ingress.prepareRows(buffer, f.key, [row], () => true);
  try {
    await Promise.race([diagnosing.promise, work]);
    assert.equal(f.open().findIncoming(f.message).voiceAttempted, true);
    enabled = false;
  } finally {
    resume.resolve();
    await work;
  }

  assert.equal(row.text, f.message.text);
  const reopened = f.open();
  const saved = reopened.findIncoming(f.message);
  assert.equal(saved.voiceAttempted, true);
  assert.equal(saved.voice.id, id);
  enabled = true;
  await ingress.prepareRows(reopened, f.key, [saved], () => true);
  assert.match(saved.text, /VOICE_INPUT_INTERRUPTED/);
  assert.equal(saved.voice, undefined);
  assert.equal(calls, 1);
});

for (const change of ['replacement plugin', 'new settings']) {
  test('a buffered transcript requires the provider that produced it, change=' + change, async t => {
    const f = savedAudio(t);
    const buffer = f.open();
    const row = buffer.append(f.message);
    const provider = { id: 'first-speech-plugin', generation: 'original-settings' };
    let current = provider;
    const diagnosing = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const recognize = t.mock.fn(async () => ({
      ok: true,
      plugin: provider.id,
      generation: provider.generation,
      text: 'prior provider fixture transcript',
    }));
    const ingress = new VoiceIngress({
      recognize,
      generationFor: () => [current],
      canRecognize: (_message, providers = []) =>
        providers.every(item => item.id === current.id && item.generation === current.generation),
      async onResult() {
        diagnosing.resolve();
        await resume.promise;
      },
    });
    t.after(() => ingress.stop());
    const work = ingress.prepareRows(buffer, f.key, [row], () => true);
    try {
      await Promise.race([diagnosing.promise, work]);
      assert.equal(f.open().findIncoming(f.message).voiceAttempted, true);
      current =
        change === 'replacement plugin'
          ? { id: 'second-speech-plugin', generation: 'second-settings' }
          : { ...provider, generation: 'updated-settings' };
    } finally {
      resume.resolve();
      await work;
    }

    const reopened = f.open();
    const saved = reopened.findIncoming(f.message);
    assert.equal(saved.text, f.message.text);
    assert.equal(saved.voice.id, id);
    assert.equal(saved.voiceAttempted, true);
    await ingress.prepareRows(reopened, f.key, [saved], () => true);
    assert.match(saved.text, /VOICE_INPUT_INTERRUPTED/);
    assert.equal(recognize.mock.callCount(), 1);
  });
}

for (const interrupted of [false, true]) {
  test(
    'forwarded audio uses the remaining budget and keeps unfinished attachments, interrupted=' + interrupted,
    async t => {
      const f = savedAudio(t);
      const buffer = f.open();
      const ordinary = buffer.append(f.message);
      const refs = ['b', 'c', 'd', 'e'].map(ch => ch.repeat(64));
      const forwarded = {
        ...f.message,
        message_id: 'forwarded-audio',
        voice: undefined,
        text: '[合并转发聊天记录]',
        forwardedRecord: {
          version: 1,
          title: '历史语音',
          items: refs.map(() => ({ sender: '历史发件人', time: '', text: '[语音，未转写]', kind: '3', depth: 0 })),
        },
        forwardedVoices: refs.map((id, index) => ({ id, index })),
      };
      const row = buffer.append(forwarded);
      const calls = [];
      const first = new VoiceIngress({
        recognize: async message => {
          const voiceId = message.voice.id;
          calls.push(voiceId);
          if (interrupted && voiceId === refs[0]) first.stop();
          return { ok: true, text: 'fixture transcript ' + voiceId[0] };
        },
      });
      await first.prepareRows(buffer, f.key, [ordinary, row], () => true);
      first.stop();
      assert.deepEqual(calls, [id, ...refs.slice(0, interrupted ? 1 : 3)]);
      const reopened = f.open();
      const restored = reopened.findIncoming(forwarded);
      const remaining = interrupted ? refs : refs.slice(3);
      assert.deepEqual(
        restored.forwardedVoices.map(ref => ref.id),
        remaining,
      );
      assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')).readerMediaPins.ids, remaining);
      const next = new VoiceIngress({
        recognize: async message => {
          calls.push(message.voice.id);
          return { ok: true, text: 'fixture transcript ' + message.voice.id[0] };
        },
      });
      await next.prepareRows(reopened, f.key, [restored], () => true);
      next.stop();
      assert.deepEqual(calls, [id, ...refs]);
      assert.equal(restored.forwardedVoices, undefined);
      assert.match(restored.forwardedRecord.items[0].text, interrupted ? /未能转写/ : /fixture transcript b/);
      assert.match(restored.forwardedRecord.items[3].text, /fixture transcript e/);
      assert.equal(restored.text, forwarded.text);
    },
  );
}

test(
  'a recovered assistant turn uses scoped images, stickers, video frames and file references from background',
  { timeout: 5000 },
  async t => {
    const f = savedAudio(t);
    const buffer = f.open();
    const older = {
      ...f.message,
      voice: undefined,
      readerReplay: 'context',
      readerGrant: 'current',
      sender_id: 'wxid_admin',
      sender_wxid: 'wxid_admin',
    };
    const archivedFile = { id: 'd'.repeat(64), name: '历史材料.pdf', size: 200 };
    const excludedFile = { id: 'e'.repeat(64), name: '其他发送者.pdf', size: 200 };
    const frames = [
      { id: 'a'.repeat(64), quoted: true },
      { id: 'b'.repeat(64), kind: 'sticker' },
      { id: 'c'.repeat(64) },
    ];
    const options = {
      workModeFor: () => 'assistant',
      assistantAccess: () => true,
      assistantBatchMs: 10,
      send: async () => {},
    };
    const engine = new SocialEngine({
      ...options,
      buffer,
      decide: () => assert.fail('history does not trigger a task'),
    });
    engine.receive({
      ...older,
      message_id: 'old-clip',
      text: '转发的视频和图片',
      images: frames,
      files: [archivedFile],
    });
    engine.receive({
      ...older,
      message_id: 'old-grant',
      readerGrant: 'withdrawn',
      text: '撤回授权的材料',
      images: [{ id: 'f'.repeat(64) }],
    });
    engine.receive({
      ...older,
      message_id: 'another-sender',
      sender_id: 'wxid_other_admin',
      sender_wxid: 'wxid_other_admin',
      files: [excludedFile],
    });
    engine.stop();

    let finish;
    const decision = new Promise(resolve => {
      finish = resolve;
    });
    const reopened = new SocialEngine({
      ...options,
      buffer: f.open(),
      decide: async (_key, prompt, metadata) => {
        finish({ prompt, metadata });
        return 'SILENT';
      },
    });
    t.after(() => reopened.stop());
    const current = { id: '9'.repeat(64) };
    reopened.receive({
      ...older,
      readerReplay: undefined,
      message_id: 'current',
      timestamp: older.timestamp + 1,
      text: '结合转发画面和历史材料里的内容回答',
      images: [current, { id: frames[0].id }],
    });
    const { prompt, metadata } = await decision;
    assert.deepEqual(metadata.images, [current, ...frames]);
    assert.deepEqual(metadata.files, [archivedFile]);
    assert.match(prompt, /"images":\["I2","I3","I4"\]/);
    assert.match(prompt, /历史材料\.pdf/);
    assert.doesNotMatch(prompt, /其他发送者\.pdf|撤回授权的材料/);
  },
);

test('the standalone plugin and managed service agree on logical reply limits', () => {
  assert.equal(maximumSynthesisSeconds, modelFields.speechLimits.maxAudioSeconds);
  assert.equal(maxReplyChars, modelFields.speechLimits.maxReplyChars);
});

function fixture(t, { failSegment, changeSegment, transcripts } = {}) {
  const reads = [],
    uploads = [],
    delivered = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    uploads.push({ url: String(url), model: options.body.get('model') });
    return Response.json({ text: transcripts ? transcripts[uploads.length - 1] : 'transcript-' + uploads.length });
  });
  const context = {
    settings,
    signal: new AbortController().signal,
    audio: {
      segments(id, options) {
        return audioSegments(this.read, id, options);
      },
      async read(voice, options) {
        assert.equal(voice, id);
        const segment = options.segment ?? 0;
        reads.push(segment);
        if (segment === failSegment) throw Error('VOICE_REFERENCE_REVOKED');
        return {
          id: segment === changeSegment ? 'b'.repeat(64) : id,
          b64: waveFile(Buffer.alloc(3200)).toString('base64'),
          durationSeconds: 60,
          totalDurationSeconds: 180,
          segmentCount: 3,
          segmentIndex: segment,
        };
      },
    },
  };
  return { context, reads, uploads, delivered };
}

test('video ingress selects the speech conversation plugin and delivers every authorized audio segment', async t => {
  assert.equal(featureConfigured(manifest, { settings }, 'voice-input-v1'), true);
  const record = { ...manifest, process: { actions: [...actions.values()] } };
  const handlers = PluginRuntime.prototype.featureHandlers.call(
    {
      records: new Map([[manifest.id, record]]),
      policy: () => ({ config: { plugins: { [manifest.id]: { settings } } } }),
      active: () => true,
    },
    'voice-input-v1',
    'wechat:private:123',
  );
  assert.deepEqual(
    handlers.map(row => row.id),
    ['speech-synthesis'],
  );
  const event = WechatOneBot.prototype.incoming.call(
    { reload() {}, allowed: () => true, ownWxid: 'self' },
    {
      event: 'message.new',
      type: 43,
      talkerId: 'peer',
      sessionId: 'peer',
      rawid: 'c'.repeat(64),
      content: '[video frames]',
      timestamp: 100,
      image: { id: 'b'.repeat(64) },
      voice: { id, durationSeconds: 180 },
    },
  );
  const message = normalizeOneBotEvent('wechat', 'wechat-onebot', event);
  assert.equal(message.voiceSource, 'video');
  const f = fixture(t);
  const ingress = new VoiceIngress({
    recognize: current => actions.get('transcribe').execute(f.context, { id: current.voice.id }),
    deliver: row => {
      f.delivered.push(row);
      return true;
    },
  });
  t.after(() => ingress.stop());
  assert.equal(await ingress.push(message), true);
  assert.deepEqual(f.reads, [0, 1, 2]);
  assert.equal(f.uploads.length, 3);
  assert.match(f.delivered[0].text, /transcript-1\ntranscript-2\ntranscript-3/);
});

test('the speech conversation plugin skips successful empty parts and still rejects a malformed response', async t => {
  for (const [transcripts, expected] of [
    [['', 'later speech', ''], { ok: true, text: 'later speech' }],
    [['', '', ''], { ok: false, code: 'VOICE_TTS_TRANSCRIPT' }],
    [['first speech', null, 'later speech'], { ok: false, code: 'VOICE_TTS_TRANSCRIPT' }],
  ]) {
    const f = fixture(t, { transcripts });
    const result = await actions.get('transcribe').execute(f.context, { id });
    assert.equal(result.ok, expected.ok);
    assert.equal(result.text, expected.text);
    assert.equal(result.code, expected.code);
    assert.deepEqual(f.reads, transcripts[1] === null ? [0, 1] : [0, 1, 2]);
    t.mock.restoreAll();
  }
});

test('revocation or a changed segment never returns a partial transcript as success', async t => {
  for (const options of [{ failSegment: 1 }, { changeSegment: 1 }]) {
    const f = fixture(t, options);
    const result = await actions.get('transcribe').execute(f.context, { id });
    assert.equal(result.ok, false);
    assert.equal(result.text, undefined);
    assert.deepEqual(f.reads, [0, 1]);
    assert.equal(f.uploads.length, 1);
    t.mock.restoreAll();
  }
});

test('realtime dialogue explicitly declines multi-part audio before uploading a truncated turn', async t => {
  const f = fixture(t);
  const result = await actions.get('converse').execute(f.context, { id, voiceAllowed: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'VOICE_REALTIME_INPUT_TOO_LONG');
  assert.deepEqual(f.reads, [0]);
  assert.equal(f.uploads.length, 0);
});
