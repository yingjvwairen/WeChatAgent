import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { prepareVoicePreview } from './voice-preview.mjs';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-preview-test-'));
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, '{}');
  const outputRoot = path.join(directory, 'output');
  const cleanup = () => {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('voice-preview-test-')) throw Error('TEST_CLEANUP_PATH_INVALID');
    fs.rmSync(directory, { recursive: true, force: true });
  };
  return { directory, configPath, outputRoot, cleanup };
}
function wav() {
  const buffer = Buffer.alloc(44 + 1600);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(1600, 40);
  return buffer;
}

test('voice preview saves validated segments and a truthful manifest without input text', async () => {
  const f = fixture();
  try {
    const audio = wav();
    const client = { voiceId: 'test-voice', async synthesize(text) { assert.equal(text, '私密的测试文字'); return { segments: [{ text, audio, durationMs: 999999 }] }; } };
    const result = await prepareVoicePreview({ ...f, text: '私密的测试文字', client });
    assert.equal(result.durationMs, 100); // Recomputed from bytes, never trusts an upstream duration.
    assert.equal(result.played, false); assert.equal(result.wechatSent, false);
    assert.equal(result.modelVerification, 'caller-configured');
    assert.deepEqual(fs.readFileSync(path.join(result.directory, result.segments[0].file)), audio);
    assert.equal(result.segments[0].sha256, crypto.createHash('sha256').update(audio).digest('hex'));
    const manifest = fs.readFileSync(result.manifestPath, 'utf8');
    assert.equal(manifest.includes('私密的测试文字'), false);
    assert.equal(manifest.includes('configPath'), false);
    const again = await prepareVoicePreview({ ...f, text: '私密的测试文字', client });
    assert.notEqual(again.directory, result.directory);
  } finally { f.cleanup(); }
});

test('failed or malformed synthesis leaves no ready preview folder', async () => {
  const f = fixture();
  try {
    await assert.rejects(prepareVoicePreview({ ...f, text: '测试', client: { async synthesize() { throw Object.assign(Error('VOICE_TIMEOUT'), { code: 'VOICE_TIMEOUT' }); } } }), { code: 'VOICE_TIMEOUT' });
    await assert.rejects(prepareVoicePreview({ ...f, text: '测试', client: { async synthesize() { return { segments: [{ audio: wav() }, { audio: Buffer.from('invalid') }] }; } } }), { code: 'VOICE_WAV_INVALID' });
    assert.equal(fs.existsSync(f.outputRoot), false);
  } finally { f.cleanup(); }
});

test('abort after synthesis does not persist audio or a manifest', async () => {
  const f = fixture(), controller = new AbortController();
  try {
    await assert.rejects(prepareVoicePreview({ ...f, text: '测试', signal: controller.signal, client: { async synthesize() { controller.abort(); return { segments: [{ audio: wav() }] }; } } }), { code: 'VOICE_ABORTED' });
    assert.equal(fs.existsSync(f.outputRoot), false);
  } finally { f.cleanup(); }
});

test('already aborted previews never call the synthesizer', async () => {
  const f = fixture(), controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(prepareVoicePreview({ ...f, text: '测试', signal: controller.signal, client: {
      async synthesize() { assert.fail('aborted synthesis must not start'); },
    } }), { code: 'VOICE_ABORTED' });
    assert.equal(fs.existsSync(f.outputRoot), false);
  } finally { f.cleanup(); }
});

test('an abort delivered while saving removes the incomplete preview', async () => {
  const f = fixture(), controller = new AbortController();
  try {
    await assert.rejects(prepareVoicePreview({ ...f, text: '测试', signal: controller.signal, client: {
      async synthesize() {
        setImmediate(() => controller.abort());
        return { segments: [{ audio: wav() }, { audio: wav() }] };
      },
    } }), { code: 'VOICE_ABORTED' });
    assert.deepEqual(fs.readdirSync(f.outputRoot), []);
  } finally { f.cleanup(); }
});

test('a linked output root is rejected before synthesis without touching its target', async () => {
  const f = fixture();
  try {
    const outside = path.join(f.directory, 'outside');
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    fs.symlinkSync(outside, f.outputRoot, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(prepareVoicePreview({ ...f, text: '测试', client: {
      async synthesize() { assert.fail('linked output paths must fail before synthesis'); },
    } }), { code: 'VOICE_PREVIEW_LINK_NOT_ALLOWED' });
    assert.deepEqual(fs.readdirSync(outside), ['keep.txt']);
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  } finally { f.cleanup(); }
});

test('malformed synthesis metadata cannot become a ready manifest', async () => {
  const f = fixture();
  try {
    for (const result of [null, {}, { segments: [null] }, { segments: [{ audio: wav() }], voiceId: { text: 'private' } }]) {
      await assert.rejects(prepareVoicePreview({ ...f, text: '测试', client: { async synthesize() { return result; } } }), { code: 'VOICE_PREVIEW_RESULT_INVALID' });
    }
    await assert.rejects(prepareVoicePreview({ ...f, text: '测试', client: {
      voiceId: 'expected-voice', async synthesize() { return { segments: [{ audio: wav() }], voiceId: 'different-voice' }; },
    } }), { code: 'VOICE_PREVIEW_RESULT_INVALID' });
    assert.equal(fs.existsSync(f.outputRoot), false);
  } finally { f.cleanup(); }
});
