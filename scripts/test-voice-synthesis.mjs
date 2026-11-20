import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DANIA_DEFAULTS, resolveDaniaConfig, splitVoiceText, inspectWav, VoiceSynthesisClient } from './voice-synthesis.mjs';

const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
function wav({ frames = 80, channels = 1, sampleRate = 8000, bits = 16, encoding = 1 } = {}) {
  const align = channels * bits / 8, dataBytes = frames * align, bytes = Buffer.alloc(44 + dataBytes + (dataBytes & 1));
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(encoding, 20); bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * align, 28);
  bytes.writeUInt16LE(align, 32); bytes.writeUInt16LE(bits, 34); bytes.write('data', 36); bytes.writeUInt32LE(dataBytes, 40);
  return bytes;
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-voice-'));
  t.after(() => { assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
async function server(t, handler) {
  const requests = [];
  const host = http.createServer(async (req, res) => {
    let raw = '';
    for await (const bytes of req) raw += bytes;
    const body = JSON.parse(raw); requests.push({ url: req.url, method: req.method, body });
    await handler(body, res, req);
  });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { host.closeAllConnections(); host.close(resolve); }));
  return { url: `http://127.0.0.1:${host.address().port}`, requests };
}
const audioResponse = (res, bytes = wav()) => { res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': bytes.length }); res.end(bytes); };
const client = (endpoint, options = {}) => new VoiceSynthesisClient({ config: { baseUrl: endpoint }, ...options });

test('voice config discovery stays under DSH_HOME when engine installDir moves, and explicit overrides win', t => {
  const root = fixture(t), home = path.join(root, 'dsh'), dir = path.join(home, 'dania-voice');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ installDir: path.join(root, 'separate-engine'), root: 'engine', speed: 1.2, volume: 0.5 }));
  const cfg = resolveDaniaConfig({ dshHome: home, overrides: { speed: 0.8 } });
  assert.equal(cfg.configPath, file); assert.equal(cfg.speed, 0.8);
  assert.equal(cfg.paths.root, path.join(root, 'separate-engine', 'engine'));
  assert.equal(cfg.paths.refAudio, path.resolve(cfg.paths.root, DANIA_DEFAULTS.refAudio));
  assert(Object.isFrozen(cfg)); assert(Object.isFrozen(cfg.paths));
  const explicit = path.join(root, 'voice.json'); fs.writeFileSync(explicit, '\uFEFF' + JSON.stringify({ installDir: 'relative-engine' }));
  assert.equal(resolveDaniaConfig({ dshHome: home, configPath: explicit }).paths.installDir, path.join(home, 'relative-engine'));
  assert.throws(() => resolveDaniaConfig({ configPath: path.join(root, 'missing.json') }), { code: 'VOICE_CONFIG_NOT_FOUND' });
  fs.writeFileSync(explicit, '[]'); assert.throws(() => resolveDaniaConfig({ configPath: explicit }), { code: 'VOICE_CONFIG_INVALID' });
});

test('voice endpoint is a literal loopback origin and settings reject invalid values', () => {
  const withAuthority = new URL('http://127.0.0.1'); withAuthority.username = 'fixture'; withAuthority.password = 'fixture';
  for (const baseUrl of ['http://example.com', 'http://localhost:9880', 'http://127.0.0.1:9880/tts', withAuthority.href, 'http://127.0.0.1/#x', 'file:///tmp/test', 'http://127.0.0.1:0']) {
    assert.throws(() => client(baseUrl), { code: 'VOICE_LOOPBACK_REQUIRED' });
  }
  assert.equal(client('http://[::1]:9880').config.baseUrl, 'http://[::1]:9880');
  for (const overrides of [{ speed: 0 }, { topK: 1.2 }, { temperature: NaN }, { refAudio: '' }, { textSplitMethod: 'invalid' }, { promptLang: '\nzh' }]) {
    assert.throws(() => new VoiceSynthesisClient({ config: overrides }), { code: 'VOICE_CONFIG_INVALID' });
  }
});

test('voice segmentation preserves text and Unicode graphemes without truncating long replies', () => {
  const text = '先说第一句话。'.repeat(11) + '😀👨‍👩‍👧‍👦e\u0301第二句话\n'.repeat(15) + ' 完成。';
  const parts = splitVoiceText(text);
  assert.equal(parts.join(''), text); assert(parts.length > 1);
  const boundaries = new Set(Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), entry => entry.index));
  let offset = 0;
  for (const part of parts) { assert(boundaries.has(offset)); assert(Array.from(part).length <= 90); offset += part.length; }
  assert.throws(() => splitVoiceText('甲'.repeat(4001)), { code: 'VOICE_TEXT_TOO_LONG' });
  assert.throws(() => splitVoiceText('a' + '\u0301'.repeat(91)), { code: 'VOICE_GRAPHEME_TOO_LONG' });
  assert.throws(() => splitVoiceText('\ud800'), { code: 'VOICE_TEXT_INVALID' });
});

test('WAV validation checks chunk bounds, frame geometry, nonempty samples and duration', () => {
  const valid = wav(); assert.equal(inspectWav(valid).durationMs, 10);
  assert.equal(inspectWav(wav({ frames: 441, sampleRate: 44100, bits: 32, encoding: 3 })).durationMs, 10);
  assert.equal(inspectWav(wav({ frames: 81, bits: 8 })).dataBytes, 81);
  const alignment = Buffer.from(valid); alignment.writeUInt16LE(99, 32);
  const dataBounds = Buffer.from(valid); dataBounds.writeUInt32LE(99999, 40);
  const compressed = Buffer.from(valid); compressed.writeUInt16LE(6, 20);
  for (const bytes of [Buffer.from('{}'), valid.subarray(0, -1), Buffer.concat([valid, Buffer.alloc(1)]), wav({ frames: 0 }), alignment, dataBounds, compressed]) {
    assert.throws(() => inspectWav(bytes), { code: 'VOICE_WAV_INVALID' });
  }
});

test('local TTS requests retain Dania defaults and return validated audio without calling any model-switch endpoint', async t => {
  const host = await server(t, (_body, res) => audioResponse(res));
  const result = await client(host.url).synthesizeSegment('你好，达妮娅。');
  assert.equal(result.durationMs, 10); assert.equal(result.format.sampleRate, 8000);
  assert.equal(result.modelVerification, 'caller-configured'); assert.match(result.voiceId, /^[a-f0-9]{64}$/);
  assert.deepEqual(host.requests, [{ url: '/tts', method: 'POST', body: {
    text: '你好，达妮娅。', text_lang: 'zh', ref_audio_path: DANIA_DEFAULTS.refAudio, prompt_text: DANIA_DEFAULTS.promptText,
    prompt_lang: 'zh', text_split_method: 'cut2', media_type: 'wav', streaming_mode: false, speed_factor: 1,
    batch_size: 1, parallel_infer: true, repetition_penalty: 1.35, temperature: 0.7, top_k: 10, top_p: 0.9, fragment_interval: 0.4,
  } }]);
  assert.notEqual(client(host.url).voiceId, new VoiceSynthesisClient({ config: { baseUrl: host.url, modelId: 'other-model' } }).voiceId);
  assert.notEqual(client(host.url).voiceId, new VoiceSynthesisClient({ config: { baseUrl: host.url, dshHome: path.join(os.tmpdir(), 'different-model-home') } }).voiceId);
});

test('segments and separate synthesis calls share one serial queue and no text is dropped', async t => {
  let active = 0, maxActive = 0;
  const host = await server(t, async (_body, res) => { active++; maxActive = Math.max(maxActive, active); await tick(10); active--; audioResponse(res); });
  const voice = client(host.url), first = '甲'.repeat(181), second = '乙'.repeat(91);
  const [a, b] = await Promise.all([voice.synthesize(first), voice.synthesize(second)]);
  assert.equal(maxActive, 1); assert.equal(a.segments.map(x => x.text).join(''), first); assert.equal(b.segments.map(x => x.text).join(''), second);
  assert.equal(host.requests.map(x => x.body.text).join(''), first + second);
  assert.equal(a.durationMs, 30); assert.equal(b.durationMs, 20);
});

test('HTTP failures, JSON masquerading as audio and redirect responses are rejected without following redirects', async t => {
  let redirected = 0;
  const destination = await server(t, (_body, res) => { redirected++; audioResponse(res); });
  const host = await server(t, (body, res) => {
    if (body.text === 'bad status') { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"secret":"do not expose"}'); }
    if (body.text === 'redirect') { res.writeHead(307, { Location: destination.url + '/tts' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': body.text === 'wrong type' ? 'application/json' : 'audio/wav' }); res.end('{}');
  });
  const voice = client(host.url);
  await assert.rejects(voice.synthesize('bad status'), { code: 'VOICE_HTTP_ERROR', status: 400 });
  await assert.rejects(voice.synthesize('wrong type'), { code: 'VOICE_AUDIO_TYPE_INVALID' });
  await assert.rejects(voice.synthesize('not a wave'), { code: 'VOICE_WAV_INVALID' });
  await assert.rejects(voice.synthesize('redirect'), { code: 'VOICE_NETWORK_ERROR' });
  assert.equal(redirected, 0);
});

test('response byte limits apply to advertised length, chunked bodies and the complete multisegment reply', async t => {
  const host = await server(t, (body, res) => {
    if (body.text === 'chunked') { res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.write(wav().subarray(0, 80)); return res.end(Buffer.alloc(80)); }
    audioResponse(res);
  });
  await assert.rejects(client(host.url, { maxResponseBytes: 100 }).synthesize('length'), { code: 'VOICE_AUDIO_TOO_LARGE' });
  await assert.rejects(client(host.url, { maxResponseBytes: 100 }).synthesize('chunked'), { code: 'VOICE_AUDIO_TOO_LARGE' });
  await assert.rejects(client(host.url, { maxTotalBytes: 300 }).synthesize('甲'.repeat(181)), { code: 'VOICE_AUDIO_TOO_LARGE' });
  assert.equal(host.requests.filter(x => x.body.text.startsWith('甲')).length, 2);
});

test('TTS timeout covers a stalled response body after successful headers', async t => {
  const host = await server(t, (_body, res) => { res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.flushHeaders(); res.write(wav().subarray(0, 20)); });
  await assert.rejects(client(host.url, { timeoutMs: 100 }).synthesize('慢响应'), { code: 'VOICE_TIMEOUT' });
});

test('cancellation interrupts body reads and a later request still works', async t => {
  let started;
  const firstStarted = new Promise(resolve => { started = resolve; });
  const host = await server(t, (body, res) => {
    if (body.text === 'cancel') { res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.flushHeaders(); started(); return; }
    audioResponse(res);
  });
  const voice = client(host.url), controller = new AbortController();
  const pending = voice.synthesize('cancel', { signal: controller.signal });
  await firstStarted; controller.abort();
  await assert.rejects(pending, { code: 'VOICE_ABORTED' });
  assert.equal((await voice.synthesize('继续')).segments.length, 1);
});

test('a cancelled queued request rejects promptly without running or interrupting the active request', async t => {
  let started, release;
  const firstStarted = new Promise(resolve => { started = resolve; });
  const host = await server(t, (body, res) => {
    if (body.text === 'first') { release = () => audioResponse(res); started(); return; }
    audioResponse(res);
  });
  const voice = client(host.url), first = voice.synthesize('first'); await firstStarted;
  const controller = new AbortController(), second = voice.synthesize('never send', { signal: controller.signal });
  controller.abort();
  await assert.rejects(Promise.race([second, tick(1000).then(() => { throw Error('queued cancellation did not return'); })]), { code: 'VOICE_ABORTED' });
  assert.equal(host.requests.length, 1); release(); await first;
  await voice.synthesize('third'); assert.deepEqual(host.requests.map(x => x.body.text), ['first', 'third']);
});

test('overlong single-segment or full-text requests fail before any HTTP request', async t => {
  const host = await server(t, (_body, res) => audioResponse(res)), voice = client(host.url);
  await assert.rejects(voice.synthesizeSegment('甲'.repeat(91)), { code: 'VOICE_SEGMENT_TOO_LONG' });
  await assert.rejects(voice.synthesize('甲'.repeat(4001)), { code: 'VOICE_TEXT_TOO_LONG' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(voice.synthesize('取消', { signal: controller.signal }), { code: 'VOICE_ABORTED' });
  assert.equal(host.requests.length, 0);
});
