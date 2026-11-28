import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const projectRoot = path.resolve(import.meta.dirname, '../..'),
  handles = new WeakMap();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) =>
  object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fault = code => Object.assign(new Error(code), { code });
const beforeExecution = code =>
  Object.assign(fault(code), {
    warmExecutionStarted: false,
    nativeStarted: false,
    recordingPossible: false,
    submitAttempted: false,
  });
const safeReason = value => typeof value === 'string' && /^(VOICE|DRAFT|AUDIO)_[A-Z0-9_]{1,80}$/.test(value);
const canonical = value => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
function noLinks(file) {
  for (let item = path.resolve(file); ; item = path.dirname(item)) {
    if (fs.lstatSync(item, { throwIfNoEntry: false })?.isSymbolicLink()) throw beforeExecution('VOICE_LINK_REJECTED');
    if (path.dirname(item) === item) return;
  }
}

export function isVoiceWarmMonitor(value, root = projectRoot) {
  return object(value) && handles.get(value)?.root === canonical(root);
}

/** A private, one-use input monitor. Before execute() no UI/audio mutex, window
 * activation, recording or playback request is sent. No automatic restart. */
export async function warmVoiceMonitor({ root = projectRoot, signal, spawnImpl = spawn, readyTimeoutMs = 5000 } = {}) {
  if (
    typeof root !== 'string' ||
    !path.isAbsolute(root) ||
    typeof spawnImpl !== 'function' ||
    !Number.isInteger(readyTimeoutMs) ||
    readyTimeoutMs < 100 ||
    readyTimeoutMs > 10000
  )
    throw beforeExecution('VOICE_WARMUP_OPTIONS_INVALID');
  if (signal?.aborted) throw beforeExecution('VOICE_CANCELLED_BEFORE_START');
  const executable = path.join(root, 'state/ui-host/WechatVoicePreview.exe');
  noLinks(executable);
  if (!fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) throw beforeExecution('VOICE_COMPONENT_MISSING');
  const nonce = crypto.randomBytes(32).toString('hex');
  let child,
    phase = 'starting',
    monitorId,
    buffer = '',
    outputBytes = 0,
    errorBytes = 0,
    committed = false,
    packet,
    stopReason,
    forceTimer,
    readyTimer,
    warmTimer,
    executionTimer,
    executionSignal;
  let resolveReady, rejectReady, resolveExecution, rejectExecution, resolveClosed;
  const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    }),
    closed = new Promise(resolve => {
      resolveClosed = resolve;
    });
  const execution = new Promise((resolve, reject) => {
    resolveExecution = resolve;
    rejectExecution = reject;
  });
  execution.catch(() => {});
  const decoder = new StringDecoder('utf8');
  const refs = active => {
    for (const value of [child, child?.stdin, child?.stdout, child?.stderr]) {
      try {
        value?.[active ? 'ref' : 'unref']?.();
      } catch {}
    }
  };
  const stop = reason => {
    if (phase === 'closed' || stopReason) return;
    stopReason = reason;
    phase = 'stopping';
    refs(true);
    try {
      child.stdin.end(committed ? 'cancel\n' : undefined);
    } catch {}
    // Keep drain pending until process exit; requesting termination is not proof.
    forceTimer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
    }, 1500);
  };
  const abort = () => stop('VOICE_CANCELLED');
  const onExit = () => {
    try {
      child.stdin.end(committed ? 'cancel\n' : undefined);
    } catch {}
    if (!committed) {
      try {
        child.kill();
      } catch {}
    }
  };
  const accept = line => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      stop('VOICE_WARMUP_PROTOCOL_INVALID');
      return;
    }
    if (phase === 'starting' && !stopReason) {
      if (
        !exact(value, [
          'ok',
          'phase',
          'protocol',
          'nonce',
          'monitorId',
          'readOnly',
          'inputSent',
          'mutexHeld',
          'maximumWarmupMs',
        ]) ||
        value.ok !== true ||
        value.phase !== 'ready' ||
        value.protocol !== 'voice-warm-v1' ||
        value.nonce !== nonce ||
        !/^[a-f0-9]{32}$/.test(value.monitorId ?? '') ||
        value.readOnly !== true ||
        value.inputSent !== false ||
        value.mutexHeld !== false ||
        value.maximumWarmupMs !== 60000
      ) {
        stop('VOICE_WARMUP_PROTOCOL_INVALID');
        return;
      }
      monitorId = value.monitorId;
      phase = 'ready';
      clearTimeout(readyTimer);
      warmTimer?.unref?.();
      refs(false);
      resolveReady();
      return;
    }
    if (!committed) {
      stop('VOICE_WARMUP_PROTOCOL_INVALID');
      return;
    }
    if (packet !== undefined || !object(value)) {
      stop('VOICE_WARMUP_PROTOCOL_INVALID');
      return;
    }
    packet = value;
  };
  const finish = (code, terminationSignal) => {
    if (phase === 'closed') return;
    phase = 'closed';
    clearTimeout(forceTimer);
    clearTimeout(readyTimer);
    clearTimeout(warmTimer);
    clearTimeout(executionTimer);
    signal?.removeEventListener('abort', abort);
    executionSignal?.removeEventListener('abort', abort);
    process.removeListener('exit', onExit);
    const tail = buffer + decoder.end();
    if (tail.trim()) {
      if (packet === undefined && committed) {
        try {
          packet = JSON.parse(tail);
        } catch {
          stopReason ??= 'VOICE_WARMUP_PROTOCOL_INVALID';
        }
      } else stopReason ??= 'VOICE_WARMUP_PROTOCOL_INVALID';
    }
    resolveClosed({ processStopped: true, executionCommitted: committed });
    if (!committed) {
      rejectReady(beforeExecution(stopReason ?? 'VOICE_WARMUP_ENDED'));
      return;
    }
    const rejected =
      exact(packet, [
        'ok',
        'phase',
        'protocol',
        'nonce',
        'monitorId',
        'reason',
        'executionStarted',
        'inputSent',
        'recordingStarted',
        'focusOwnershipTransferred',
      ]) &&
      packet.ok === false &&
      packet.phase === 'rejected' &&
      packet.protocol === 'voice-warm-v1' &&
      packet.nonce === nonce &&
      packet.monitorId === monitorId &&
      safeReason(packet.reason) &&
      ['executionStarted', 'inputSent', 'recordingStarted', 'focusOwnershipTransferred'].every(
        key => packet[key] === false,
      );
    if (rejected && code === 1 && !terminationSignal && !stopReason) {
      rejectExecution(beforeExecution(packet.reason));
      return;
    }
    if (
      !object(packet) ||
      packet.phase !== undefined ||
      stopReason === 'VOICE_WARMUP_PROTOCOL_INVALID' ||
      terminationSignal ||
      (code !== 0 && code !== 1)
    ) {
      rejectExecution(
        Object.assign(fault(stopReason ?? 'VOICE_WARMUP_RESULT_UNCONFIRMED'), {
          recordingPossible: true,
          submitAttempted: null,
        }),
      );
      return;
    }
    resolveExecution({ raw: packet, exitCode: code, cancelling: !!stopReason });
  };
  const handle = Object.freeze({
    ready: Object.freeze({
      protocol: 'voice-warm-v1',
      readOnly: true,
      inputSent: false,
      mutexHeld: false,
      maximumWarmupMs: 60000,
    }),
    execute(request, { production = false, signal: nextSignal, onCommit } = {}) {
      if (phase !== 'ready' || committed || stopReason)
        return Promise.reject(beforeExecution(stopReason ?? 'VOICE_WARMUP_NOT_READY'));
      if (nextSignal?.aborted) return Promise.reject(beforeExecution('VOICE_CANCELLED_BEFORE_START'));
      if (
        typeof production !== 'boolean' ||
        !object(request) ||
        request.action !== (production ? 'timedVoiceSend' : 'timedVoicePreview') ||
        !object(request.focusHandoff) ||
        (onCommit !== undefined && typeof onCommit !== 'function')
      )
        return Promise.reject(beforeExecution('VOICE_WARMUP_REQUEST_INVALID'));
      const line =
        JSON.stringify({
          action: 'executeWarmVoice',
          version: 1,
          nonce,
          monitorId,
          mode: production ? 'private-send' : 'private-once',
          request,
        }) + '\n';
      // Native ReadLine caps UTF-16 characters independently of UTF-8 bytes.
      if (line.length > 65537 || Buffer.byteLength(line) > 131072)
        return Promise.reject(beforeExecution('VOICE_WARMUP_REQUEST_INVALID'));
      committed = true;
      phase = 'executing';
      clearTimeout(warmTimer);
      executionSignal = nextSignal;
      refs(true);
      executionTimer = setTimeout(() => stop('VOICE_PROCESS_TIMEOUT'), 18500);
      nextSignal?.addEventListener('abort', abort, { once: true });
      try {
        onCommit?.();
        child.stdin.write(line, error => {
          if (error) stop('VOICE_PIPE_FAILED');
        });
      } catch {
        stop('VOICE_PIPE_FAILED');
      }
      if (nextSignal?.aborted) abort();
      return execution;
    },
    close() {
      stop('VOICE_WARMUP_CLOSED');
      return closed;
    },
    drain() {
      return closed;
    },
  });
  handles.set(handle, { root: canonical(root) });
  try {
    child = spawnImpl(executable, ['--private-warm'], {
      cwd: root,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.on('error', () => stop('VOICE_START_FAILED'));
    child.stdin.on('error', () => stop('VOICE_PIPE_FAILED'));
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > 32768) {
        stop('VOICE_WARMUP_PROTOCOL_INVALID');
        return;
      }
      buffer += decoder.write(chunk);
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        accept(line);
      }
    });
    child.stderr.on('data', chunk => {
      errorBytes += chunk.length;
      if (errorBytes > 32768) stop('VOICE_WARMUP_PROTOCOL_INVALID');
    });
    child.once('close', finish);
    process.once('exit', onExit);
    readyTimer = setTimeout(() => stop('VOICE_WARMUP_READY_TIMEOUT'), readyTimeoutMs);
    warmTimer = setTimeout(() => stop('VOICE_WARMUP_TIMEOUT'), 60000);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdin.write(JSON.stringify({ action: 'warmVoiceMonitor', version: 1, nonce }) + '\n');
    if (signal?.aborted) abort();
  } catch {
    if (!child) {
      phase = 'closed';
      resolveClosed({ processStopped: true, executionCommitted: false });
      rejectReady(beforeExecution('VOICE_START_FAILED'));
    } else stop('VOICE_START_FAILED');
  }
  await ready;
  return handle;
}
