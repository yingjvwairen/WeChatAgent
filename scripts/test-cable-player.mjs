import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CablePlayer, inspectPlaybackWav } from './cable-player.mjs';

function wav({ rate = 32000, channels = 1, floating = false, frames = rate / 10 } = {}) {
  const bytes = floating ? 4 : 2, align = channels * bytes, audio = Buffer.alloc(44 + frames * align);
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(floating ? 3 : 1, 20); audio.writeUInt16LE(channels, 22); audio.writeUInt32LE(rate, 24);
  audio.writeUInt32LE(rate * align, 28); audio.writeUInt16LE(align, 32); audio.writeUInt16LE(bytes * 8, 34);
  audio.write('data', 36); audio.writeUInt32LE(frames * align, 40);
  return audio;
}
function fixture(t, behavior = {}, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cable-player-test-'));
  const calls = []; let child;
  const player = new CablePlayer({ renderId: 'fixture-cable-render-id', executable: process.execPath, tempRoot: root,
    stopTimeoutMs: 20, timeoutGraceMs: 500, ...options,
    spawnImpl(executable, args, settings) {
      child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.killed = false; const file = args[args.indexOf('--wav') + 1], format = inspectPlaybackWav(fs.readFileSync(file));
      calls.push({ executable, args, settings, file, initialAudio: fs.readFileSync(file) });
      child.finish = (code = 0) => { child.emit('close', code); };
      child.success = () => {
        child.stdout.write(JSON.stringify({ ok: true, mode: 'play-wav', playbackComplete: true, durationMs: format.durationMs,
          elapsedMs: Math.ceil(format.durationMs), outputFrames: Math.ceil(format.durationMs * 48), audioStarted: true,
          captureOpened: false, recordingSaved: false, systemSettingsChanged: false, wechatVerified: false }) + '\n');
        child.finish();
      };
      child.kill = () => { child.killed = true; if (behavior.killCloses !== false) child.finish(2); return true; };
      let input = '';
      child.stdin.on('data', chunk => {
        input += chunk;
        while (input.includes('\n')) {
          const end = input.indexOf('\n'), command = input.slice(0, end); input = input.slice(end + 1);
          if (command === 'play') behavior.play?.(child);
          if (command === 'cancel') {
            if (behavior.cancel) behavior.cancel(child);
            else if (!behavior.ignoreCancel) child.finish(2);
          }
        }
      });
      return child;
    },
  });
  t.after(async () => {
    await player.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('cable-player-test-'));
    assert.deepEqual(fs.readdirSync(root), []); fs.rmdirSync(root);
  });
  return { player, calls, root, child: () => child };
}

test('WAV preflight accepts common synthesis output and rejects malformed, unsupported and overlong audio', () => {
  assert.equal(inspectPlaybackWav(wav()).sampleRate, 32000);
  assert.equal(inspectPlaybackWav(wav({ floating: true, rate: 48000, channels: 2 })).encoding, 'float');
  const invalid = [Buffer.from('RIFF'), wav(), wav(), wav({ floating: true }), wav({ floating: true })];
  invalid[1].writeUInt32LE(0, 4); invalid[2].writeUInt32LE(0xFFFFFFFF, 40);
  invalid[3].writeFloatLE(NaN, 44); invalid[4].writeFloatLE(1.1, 44);
  for (const audio of invalid) assert.throws(() => inspectPlaybackWav(audio), /CABLE_WAV_INVALID/);
  assert.throws(() => inspectPlaybackWav(wav({ channels: 3 })), /CABLE_WAV_FORMAT_UNSUPPORTED/);
  assert.throws(() => inspectPlaybackWav(wav({ rate: 8000, frames: 8000 * 60 + 1 })), /CABLE_WAV_DURATION_LIMIT/);
});

test('playback snapshots audio, binds the exact endpoint, uses a hidden non-shell process and cleans its temporary file', async t => {
  const f = fixture(t, { play(child) { setImmediate(() => child.success()); } });
  const audio = wav(), expected = Buffer.from(audio), pending = f.player.playWav(audio); audio.fill(1);
  const result = await pending;
  assert.equal(result.playbackComplete, true); assert.equal(result.wechatVerified, false); assert.equal(result.durationMs, 100);
  assert.deepEqual(f.calls[0].initialAudio, expected);
  assert.deepEqual(f.calls[0].args.slice(0, 3), ['--play-wav', '--render-id', 'fixture-cable-render-id']);
  assert.equal(f.calls[0].settings.windowsHide, true); assert.equal(f.calls[0].settings.shell, false);
  assert.deepEqual(f.calls[0].settings.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(fs.existsSync(f.calls[0].file), false);
});

test('invalid audio and pre-aborted work never launch the native process or create a temporary file', async t => {
  const f = fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(f.player.playWav(wav(), { signal: controller.signal }), { code: 'CABLE_PLAYER_ABORTED' });
  await assert.rejects(f.player.playWav(Buffer.from('bad')), { code: 'CABLE_WAV_INVALID' });
  assert.equal(f.calls.length, 0); assert.deepEqual(fs.readdirSync(f.root), []);
});

test('a linked ancestor of the temporary root is refused before any file or process is created', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cable-linked-root-'));
  const actual = path.join(root, 'actual'), nested = path.join(actual, 'nested'), link = path.join(root, 'link');
  fs.mkdirSync(actual); fs.mkdirSync(nested); fs.symlinkSync(actual, link, process.platform === 'win32' ? 'junction' : 'dir');
  let calls = 0;
  const player = new CablePlayer({ renderId: 'fixture', executable: process.execPath, tempRoot: path.join(link, 'nested'), spawnImpl() { calls++; } });
  try {
    await assert.rejects(player.playWav(wav()), { code: 'CABLE_PLAYER_TEMP_INVALID' });
    assert.equal(calls, 0); assert.deepEqual(fs.readdirSync(nested), []);
  } finally {
    await player.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('cable-linked-root-'));
    fs.unlinkSync(link); fs.rmdirSync(nested); fs.rmdirSync(actual); fs.rmdirSync(root);
  }
});

test('abort waits for process close and prevents later success from being reported', async t => {
  let release;
  const f = fixture(t, { cancel(child) { release = () => child.success(); } });
  const controller = new AbortController(), pending = f.player.playWav(wav(), { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'CABLE_PLAYER_ABORTED' });
  controller.abort();
  assert.equal(fs.existsSync(f.calls[0].file), true);
  release(); await rejected;
  assert.equal(fs.existsSync(f.calls[0].file), false); assert.equal(f.child().killed, false);
});

test('an unresponsive cancellation is terminated and is never replayed', async t => {
  const f = fixture(t, { ignoreCancel: true }), controller = new AbortController();
  const pending = f.player.playWav(wav(), { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'CABLE_PLAYER_ABORTED' }); controller.abort(); await rejected;
  assert.equal(f.child().killed, true); assert.equal(f.calls.length, 1);
});

test('if process termination cannot be confirmed the player fails closed for future work', async t => {
  const f = fixture(t, { ignoreCancel: true, killCloses: false }), controller = new AbortController();
  const pending = f.player.playWav(wav(), { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'CABLE_PLAYER_STOP_UNCONFIRMED' }); controller.abort(); await rejected;
  await assert.rejects(f.player.playWav(wav()), { code: 'CABLE_PLAYER_CLOSED' }); assert.equal(f.calls.length, 1);
});

test('the playback lifetime is bounded and idle stdout cannot hang the caller', async t => {
  const f = fixture(t, {}, { timeoutGraceMs: 20 });
  await assert.rejects(f.player.playWav(wav({ rate: 8000, frames: 8 })), { code: 'CABLE_PLAYER_TIMEOUT' });
  assert.equal(f.calls.length, 1);
});

test('concurrent playback is refused and explicit stop or close cancels the active stream', async t => {
  const f = fixture(t), first = f.player.playWav(wav());
  const rejected = assert.rejects(first, { code: 'CABLE_PLAYER_STOPPED' });
  await assert.rejects(f.player.playWav(wav()), { code: 'CABLE_PLAYER_BUSY' });
  await f.player.stop(); await rejected;
  const second = f.player.playWav(wav()), secondRejected = assert.rejects(second, { code: 'CABLE_PLAYER_CLOSED' });
  await f.player.close(); await secondRejected;
  await assert.rejects(f.player.playWav(wav()), { code: 'CABLE_PLAYER_CLOSED' });
});

test('native failure codes stay bounded and malformed or oversized output stops playback', async t => {
  const denied = fixture(t, { play(child) { child.stdout.write('{"ok":false,"code":"AUDIO_VIRTUAL_ENDPOINT_REQUIRED"}\n'); child.finish(2); } });
  await assert.rejects(denied.player.playWav(wav()), { code: 'AUDIO_VIRTUAL_ENDPOINT_REQUIRED' });
  for (const output of ['private device diagnostic\n', 'x'.repeat(129)]) {
    const f = fixture(t, { play(child) { child.stdout.write(output); } }, { maxResponseBytes: 128 });
    await assert.rejects(f.player.playWav(wav()), error => /^CABLE_PLAYER_(PROTOCOL_INVALID|RESPONSE_TOO_LARGE)$/.test(error.code) && !error.message.includes('private'));
  }
});
