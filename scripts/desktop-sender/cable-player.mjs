import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { inspectWav } from './wav.mjs';

export const CABLE_PLAYBACK_LIMITS = Object.freeze({ maxBytes: 32 * 1024 * 1024, maxDurationMs: 60000 });
const rates = new Set([8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000]);
const fault = code => Object.assign(new Error(code), { code });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validCode = code => typeof code === 'string' && /^AUDIO_[A-Z0-9_]{1,80}$/.test(code);
function noLinks(target) {
  let current = path.resolve(target);
  for (;;) {
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw fault('CABLE_PLAYER_TEMP_INVALID');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function inspectPlaybackWav(
  audio,
  { maxDurationMs = CABLE_PLAYBACK_LIMITS.maxDurationMs, maxBytes = CABLE_PLAYBACK_LIMITS.maxBytes } = {},
) {
  if (
    !Number.isInteger(maxDurationMs) ||
    maxDurationMs < 1 ||
    maxDurationMs > 1024000 ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 44 ||
    maxBytes > 128 * 1024 * 1024
  )
    throw fault('CABLE_WAV_INVALID');
  if (!Buffer.isBuffer(audio) || audio.length > maxBytes) throw fault('CABLE_WAV_INVALID');
  let format;
  try {
    format = inspectWav(audio);
  } catch {
    throw fault('CABLE_WAV_INVALID');
  }
  if (
    ![1, 2].includes(format.channels) ||
    !rates.has(format.sampleRate) ||
    !(
      (format.encoding === 'pcm' && format.bitsPerSample === 16) ||
      (format.encoding === 'float' && format.bitsPerSample === 32)
    )
  )
    throw fault('CABLE_WAV_FORMAT_UNSUPPORTED');
  if (format.durationMs > maxDurationMs) throw fault('CABLE_WAV_DURATION_LIMIT');
  for (let offset = 12; offset < audio.length;) {
    const tag = audio.toString('ascii', offset, offset + 4),
      size = audio.readUInt32LE(offset + 4),
      begin = offset + 8;
    if (tag === 'fmt ' && ((size !== 16 && size !== 18) || (size === 18 && audio.readUInt16LE(begin + 16) !== 0)))
      throw fault('CABLE_WAV_FORMAT_UNSUPPORTED');
    if (tag === 'data' && format.encoding === 'float')
      for (let index = begin; index < begin + size; index += 4) {
        const sample = audio.readFloatLE(index);
        if (!Number.isFinite(sample) || Math.abs(sample) > 1) throw fault('CABLE_WAV_INVALID');
      }
    offset = begin + size + (size & 1);
  }
  return format;
}

/** Explicit, cancellable playback to a previously selected VB-CABLE endpoint.
 * It never changes sound settings, captures a microphone, starts WeChat or sends.
 * A successful return confirms native playback, not reception or message delivery.
 */
export class CablePlayer {
  constructor({
    renderId,
    executable = path.resolve(import.meta.dirname, '../../state/ui-host/AudioRouteProbe.exe'),
    tempRoot = os.tmpdir(),
    stopTimeoutMs = 750,
    timeoutGraceMs = 3000,
    maxResponseBytes = 8192,
    spawnImpl = spawn,
  } = {}) {
    if (
      typeof renderId !== 'string' ||
      !renderId ||
      renderId.length > 1024 ||
      /[\0\r\n]/u.test(renderId) ||
      typeof executable !== 'string' ||
      !path.isAbsolute(executable) ||
      typeof tempRoot !== 'string' ||
      !path.isAbsolute(tempRoot) ||
      !Number.isInteger(stopTimeoutMs) ||
      stopTimeoutMs < 10 ||
      stopTimeoutMs > 3000 ||
      !Number.isInteger(timeoutGraceMs) ||
      timeoutGraceMs < 20 ||
      timeoutGraceMs > 10000 ||
      !Number.isInteger(maxResponseBytes) ||
      maxResponseBytes < 128 ||
      maxResponseBytes > 65536 ||
      typeof spawnImpl !== 'function'
    )
      throw fault('CABLE_PLAYER_OPTIONS_INVALID');
    Object.assign(this, {
      renderId,
      executable,
      tempRoot: path.resolve(tempRoot),
      stopTimeoutMs,
      timeoutGraceMs,
      maxResponseBytes,
      spawnImpl,
    });
    this.active = null;
    this.closed = false;
    this.failed = false;
  }

  async playWav(audio, { signal } = {}) {
    if (this.closed || this.failed) throw fault('CABLE_PLAYER_CLOSED');
    if (this.active) throw fault('CABLE_PLAYER_BUSY');
    if (
      signal !== undefined &&
      (!signal ||
        typeof signal.aborted !== 'boolean' ||
        typeof signal.addEventListener !== 'function' ||
        typeof signal.removeEventListener !== 'function')
    )
      throw fault('CABLE_PLAYER_OPTIONS_INVALID');
    if (signal?.aborted) throw fault('CABLE_PLAYER_ABORTED');
    // Snapshot the caller's data before validation so later Buffer mutation cannot change playback.
    if (!Buffer.isBuffer(audio) || audio.length > CABLE_PLAYBACK_LIMITS.maxBytes) throw fault('CABLE_WAV_INVALID');
    const bytes = Buffer.from(audio);
    let format;
    try {
      format = inspectPlaybackWav(bytes);
    } catch (error) {
      bytes.fill(0);
      throw error;
    }
    const operation = { stop: null, done: null };
    this.active = operation;
    let directory, file, completionError;
    try {
      if (!fs.statSync(this.executable, { throwIfNoEntry: false })?.isFile()) throw fault('CABLE_PLAYER_NOT_BUILT');
      noLinks(this.tempRoot);
      const rootStat = fs.lstatSync(this.tempRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw fault('CABLE_PLAYER_TEMP_INVALID');
      directory = fs.mkdtempSync(path.join(this.tempRoot, 'wechat-cable-play-'));
      file = path.join(directory, 'voice.wav');
      noLinks(file);
      fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
      bytes.fill(0);
      if (signal?.aborted) throw fault('CABLE_PLAYER_ABORTED');
      noLinks(file);
      operation.done = this.#run(file, format, signal, operation);
      return await operation.done;
    } catch (error) {
      completionError = error;
      throw error;
    } finally {
      bytes.fill(0);
      this.active = null;
      if (directory) {
        const target = path.resolve(directory);
        if (
          path.dirname(target) !== this.tempRoot ||
          !path.basename(target).startsWith('wechat-cable-play-') ||
          file !== path.join(target, 'voice.wav')
        )
          throw fault('CABLE_PLAYER_TEMP_INVALID');
        // Delete only the owned audio file and empty directory, never recursively traverse.
        try {
          noLinks(file);
          if (fs.existsSync(file)) fs.unlinkSync(file);
          fs.rmdirSync(target);
        } catch {
          this.failed = true;
          if (completionError) completionError.cleanupFailed = true;
          else throw fault('CABLE_PLAYER_CLEANUP_FAILED');
        }
      }
    }
  }

  #run(file, format, signal, operation) {
    return new Promise((resolve, reject) => {
      let child,
        output = Buffer.alloc(0),
        response,
        stopReason,
        settled = false,
        lifetime,
        terminateTimer,
        terminationDeadline;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(lifetime);
        clearTimeout(terminateTimer);
        clearTimeout(terminationDeadline);
        signal?.removeEventListener('abort', aborted);
        if (error) reject(error);
        else resolve(result);
      };
      const forceStop = () => {
        if (settled) return;
        try {
          child.kill();
        } catch {}
        if (!settled)
          terminationDeadline = setTimeout(() => {
            this.failed = true;
            finish(fault('CABLE_PLAYER_STOP_UNCONFIRMED'));
          }, this.stopTimeoutMs);
      };
      const stop = code => {
        if (settled || stopReason) return;
        stopReason = code;
        try {
          child.stdin.end('cancel\n');
        } catch {}
        if (!settled) terminateTimer = setTimeout(forceStop, this.stopTimeoutMs);
      };
      const aborted = () => stop('CABLE_PLAYER_ABORTED');
      operation.stop = stop;
      try {
        child = this.spawnImpl(this.executable, ['--play-wav', '--render-id', this.renderId, '--wav', file], {
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        finish(fault('CABLE_PLAYER_START_FAILED'));
        return;
      }
      child.stderr.resume();
      child.on('error', () => stop('CABLE_PLAYER_START_FAILED'));
      child.stdin.on('error', () => {
        if (!response) stop('CABLE_PLAYER_PIPE_FAILED');
      });
      child.stdout.on('data', chunk => {
        if (settled || stopReason) return;
        output = Buffer.concat([output, Buffer.from(chunk)]);
        if (output.length > this.maxResponseBytes) {
          stop('CABLE_PLAYER_RESPONSE_TOO_LARGE');
          return;
        }
        const newline = output.indexOf(10);
        if (newline >= 0) {
          if (
            response ||
            output
              .subarray(newline + 1)
              .toString('utf8')
              .trim()
          ) {
            stop('CABLE_PLAYER_PROTOCOL_INVALID');
            return;
          }
          try {
            response = JSON.parse(output.subarray(0, newline).toString('utf8'));
          } catch {
            stop('CABLE_PLAYER_PROTOCOL_INVALID');
          }
        }
      });
      child.on('close', code => {
        if (settled) return;
        if (stopReason) {
          finish(fault(stopReason));
          return;
        }
        if (!record(response)) {
          finish(fault('CABLE_PLAYER_PROTOCOL_INVALID'));
          return;
        }
        if (response.ok === false && validCode(response.code)) {
          finish(fault(response.code));
          return;
        }
        if (
          code !== 0 ||
          response.ok !== true ||
          response.mode !== 'play-wav' ||
          response.playbackComplete !== true ||
          response.audioStarted !== true ||
          response.captureOpened !== false ||
          response.recordingSaved !== false ||
          response.systemSettingsChanged !== false ||
          response.wechatVerified !== false ||
          !Number.isFinite(response.durationMs) ||
          Math.abs(response.durationMs - format.durationMs) > 1 ||
          !Number.isFinite(response.elapsedMs) ||
          response.elapsedMs < 0 ||
          response.elapsedMs > format.durationMs + this.timeoutGraceMs ||
          !Number.isSafeInteger(response.outputFrames) ||
          response.outputFrames <= 0
        ) {
          finish(fault('CABLE_PLAYER_PROTOCOL_INVALID'));
          return;
        }
        finish(null, {
          playbackComplete: true,
          durationMs: format.durationMs,
          elapsedMs: response.elapsedMs,
          sourceFormat: format,
          outputFrames: response.outputFrames,
          wechatVerified: false,
        });
      });
      lifetime = setTimeout(() => stop('CABLE_PLAYER_TIMEOUT'), Math.ceil(format.durationMs) + this.timeoutGraceMs);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
      else
        try {
          child.stdin.write('play\n');
        } catch {
          stop('CABLE_PLAYER_PIPE_FAILED');
        }
    });
  }

  stop() {
    this.active?.stop?.('CABLE_PLAYER_STOPPED');
    return this.active?.done?.catch(() => {}) ?? Promise.resolve();
  }
  close() {
    this.closed = true;
    this.active?.stop?.('CABLE_PLAYER_CLOSED');
    return this.active?.done?.catch(() => {}) ?? Promise.resolve();
  }
}
