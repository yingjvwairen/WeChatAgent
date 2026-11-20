import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveDaniaConfig } from './voice-synthesis.mjs';
import { VoiceProfileStore } from './voice-profiles.mjs';
import { startDaniaServer, probeVoiceService, voiceServiceFiles } from './dania-server.mjs';
import { readSpeechProviderView } from './speech-provider-settings.mjs';
import { synthesizeConfigured } from './cloud-speech.mjs';

const fault = code => Object.assign(new Error(code), { code });
function waitFor(task, signal) {
  if (!signal) return task;
  if (signal.aborted) return Promise.reject(fault('VOICE_SERVICE_ABORTED'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(fault('VOICE_SERVICE_ABORTED'));
    signal.addEventListener('abort', abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Shared for one robot lifetime, including Reader selection changes.
 * Existing services may be used but only this instance's ChildProcess is stopped. */
export function createManagedVoiceService({ root = path.resolve(import.meta.dirname, '..'),
  loadConfig = () => resolveDaniaConfig({ configPath: voiceServiceFiles(root).configPath }),
  start = startDaniaServer, probe = probeVoiceService,
  createProfiles = () => new VoiceProfileStore({ root }),
  createClient = () => new VoiceProfileStore({ root }).createSynthesisClient(),
  timeoutMs = 300000, pollMs = 500 } = {}) {
  const lifecycle = new AbortController(), operations = new Set(), files = voiceServiceFiles(root);
  let owned, pending, closeTask, cleanupFailure, closed = false, endpoint;
  const active = signal => { if (cleanupFailure) throw cleanupFailure; if (closed || lifecycle.signal.aborted || signal?.aborted) throw fault('VOICE_SERVICE_ABORTED'); };
  const currentConfig = () => {
    const config = loadConfig();
    if (endpoint !== undefined && config.baseUrl !== endpoint) throw fault('VOICE_SERVICE_CONFIG_CHANGED');
    endpoint = config.baseUrl; return config;
  };
  const ready = async config => {
    const state = await probe(config, { signal: lifecycle.signal });
    if (state.available && !state.compatible) throw fault('VOICE_SERVICE_INCOMPATIBLE');
    if (!state.available) return false;
    // An automatically launched instance publishes OpenAPI before profile load.
    // Wait for its owning supervisor to finish the initial model transition.
    if (fs.existsSync(files.lock)) {
      try {
        const lock = JSON.parse(fs.readFileSync(files.lock, 'utf8')), runtime = JSON.parse(fs.readFileSync(files.state, 'utf8'));
        return runtime.status === 'ready' && runtime.serviceEpoch === lock.serviceEpoch && state.serviceEpoch === lock.serviceEpoch ? state : false;
      } catch { return false; }
    }
    return state;
  };
  const load = async () => {
    active(); const config = currentConfig();
    if (owned?.alive) {
      if (!await ready(config)) throw fault('VOICE_SERVICE_UNAVAILABLE');
      return { ready: true, owned: true };
    }
    if (owned) { await owned.stop(); owned = null; }
    const existing = await ready(config);
    if (existing) return { ready: true, owned: false };
    active();
    try {
      owned = await start({ root, config, signal: lifecycle.signal, timeoutMs, pollMs, applySelectedAtStart: false });
      active(); return { ready: true, owned: true };
    } catch (error) {
      // Another manual/automatic launcher won the same project lease. Reuse
      // when ready; never delete its lease or terminate its saved process ID.
      if (error?.code !== 'VOICE_SERVICE_BUSY') throw error;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        active(); if (await ready(config)) return { ready: true, owned: false };
        await delay(pollMs, undefined, { signal: lifecycle.signal });
      }
      throw fault('VOICE_SERVICE_START_TIMEOUT');
    }
  };
  const ensureRunning = ({ signal } = {}) => {
    try { active(signal); } catch (error) { return Promise.reject(error); }
    if (!pending) {
      pending = load().catch(error => {
        if (error?.code === 'VOICE_SERVICE_CLEANUP_UNCONFIRMED') { cleanupFailure = error; throw error; }
        if (lifecycle.signal.aborted) throw fault('VOICE_SERVICE_ABORTED');
        if (/^VOICE_SERVICE_[A-Z0-9_]+$/.test(error?.code ?? '')) throw error;
        throw fault('VOICE_SERVICE_START_FAILED');
      });
      const current = pending;
      current.finally(() => { if (pending === current) pending = null; }).catch(() => {});
    }
    return waitFor(pending, signal);
  };
  const ensureReady = async ({ signal } = {}) => {
    active(signal);
    if (readSpeechProviderView({root}).tts.mode === 'cloud') return { ready: true, owned: false, provider: 'cloud' };
    let view;
    try { view = await createProfiles().snapshot(); }
    catch { active(signal); throw fault('VOICE_SERVICE_PROFILE_NOT_APPLIED'); }
    active(signal);
    if (!view.applied) throw fault('VOICE_SERVICE_PROFILE_NOT_APPLIED');
    return {ready: true, owned: !!owned?.alive, provider: 'local'};
  };
  const useProfile = ({expectedVersion, id} = {}) => {
    const operation = (async () => {
      active();
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id))
        throw fault('VOICE_PROFILE_INVALID');
      const assertLocal = () => {
        if (readSpeechProviderView({root}).tts.mode !== 'local') throw fault('VOICE_SERVICE_LOCAL_REQUIRED');
      };
      assertLocal();
      const store = createProfiles(), current = await store.snapshot();
      if (current.version !== expectedVersion) throw fault('VOICE_PROFILE_VERSION_CONFLICT');
      if (!current.profiles.some(profile => profile.id === id)) throw fault('VOICE_PROFILE_NOT_FOUND');
      await ensureRunning({signal:lifecycle.signal});
      active(); assertLocal();
      return store.select({expectedVersion, id, apply:true, signal:lifecycle.signal});
    })();
    operations.add(operation);
    operation.finally(()=>operations.delete(operation)).catch(()=>{});
    return operation;
  };
  const synthesize = (text, { signal, canSynthesize } = {}) => {
    const operation = (async () => {
      active(signal);
      const combined = signal ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal;
      return synthesizeConfigured({root, text, signal:combined, canSynthesize, synthesizeLocal:async (value, options) => {
        active(options.signal);
        return createClient().synthesize(value, options);
      }});
    })();
    operations.add(operation); operation.finally(() => operations.delete(operation)).catch(() => {});
    return operation;
  };
  const close = () => closeTask ??= (async () => {
    closed = true; lifecycle.abort();
    const settled = await Promise.allSettled([pending, ...operations].filter(Boolean));
    if (owned) await owned.stop();
    if (cleanupFailure) throw cleanupFailure;
    const unsafe = settled.find(row => row.status === 'rejected' && row.reason?.code === 'VOICE_SERVICE_CLEANUP_UNCONFIRMED');
    if (unsafe) throw unsafe.reason;
    return { stopped: true };
  })();
  return { ensureReady, useProfile, synthesize, close };
}
