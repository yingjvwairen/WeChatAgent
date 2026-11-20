import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {saveSpeechProviders,voiceProfileCatalogFile} from './speech-provider-settings.mjs';
import { DANIA_DEFAULTS, resolveDaniaConfig, VoiceSynthesisClient, withVoiceOperation, readVoiceOperationState } from './voice-synthesis.mjs';

// Local api_v2.py exposes GET /set_gpt_weights and /set_sovits_weights,
// both returning {message:"success"}. They individually lock the TTS pipeline;
// the client lock spans BOTH requests, reference refresh, and every TTS segment.
// There is no loaded-weight introspection endpoint. "acknowledged" describes
// those replies, not independently verified weights or a perpetual service state.
const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const active = signal => { if (signal?.aborted) throw fail('VOICE_ABORTED'); };
const fields = ['gptWeights', 'sovitsWeights', 'refAudio', 'promptText', 'promptLang', 'textLang', 'speed', 'temperature', 'topK', 'topP', 'repetitionPenalty', 'fragmentInterval', 'textSplitMethod'];
const languages = new Set(['auto', 'auto_yue', 'en', 'zh', 'ja', 'yue', 'ko', 'all_zh', 'all_ja', 'all_yue', 'all_ko']);
const extensions = { gptWeights: new Set(['.ckpt']), sovitsWeights: new Set(['.pth']), refAudio: new Set(['.wav', '.flac', '.mp3', '.ogg', '.m4a', '.aac']) };
const idPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const validEpoch = value => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(value);
const fingerprint = config => crypto.createHash('sha256').update(JSON.stringify(fields.map(key => [key, config[key]]))).digest('hex');
function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
function boundedJson(file, limit = 1024 * 1024) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw 0;
    const bytes = fs.readFileSync(file);
    if (bytes.length > limit) throw 0;
    return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch { throw fail('VOICE_PROFILES_STORAGE_INVALID'); }
}
function atomicSave(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink() || (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())) throw fail('VOICE_PROFILES_STORAGE_INVALID');
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  let fd;
  try {
    const bytes=JSON.stringify(value,null,2)+'\n';
    if(Buffer.byteLength(bytes)>1024*1024)throw fail('VOICE_PROFILES_STORAGE_INVALID');
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd,bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
  } catch { throw fail('VOICE_PROFILES_STORAGE_FAILED'); }
  finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch {} }
}

export class VoiceProfileStore {
  #configPath; #modelRoots; #fetch; #timeout; #healthTimeout; #coordinator; #baseUrl;
  constructor({ root = process.cwd(), configPath, modelRoots, fetchImpl = fetch, timeoutMs = 120000, healthTimeoutMs = 1500, coordinatorDirectory } = {}) {
    this.root = path.resolve(root);
    this.#configPath = path.resolve(configPath ?? path.join(this.root, 'state/dania-voice/config.json'));
    const base = this.#base();
    this.#baseUrl = base.baseUrl;
    if (modelRoots !== undefined && (!Array.isArray(modelRoots) || modelRoots.length < 1 || modelRoots.length > 8)) throw fail('VOICE_PROFILE_ROOT_INVALID');
    this.#modelRoots = (modelRoots ?? [base.paths.root]).map(item => {
      if (typeof item !== 'string' || !path.isAbsolute(item) || /^[/\\]{2}/.test(item)) throw fail('VOICE_PROFILE_ROOT_INVALID');
      try {
        const full = path.resolve(item), real = fs.realpathSync(full);
        if (!fs.statSync(real).isDirectory() || !inside(full, real) || !inside(real, full)) throw 0;
        return real;
      } catch { throw fail('VOICE_PROFILE_ROOT_INVALID'); }
    });
    if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000 || !Number.isSafeInteger(healthTimeoutMs) || healthTimeoutMs < 1 || healthTimeoutMs > 30000) throw fail('VOICE_PROFILE_OPTIONS_INVALID');
    this.#fetch = fetchImpl; this.#timeout = timeoutMs; this.#healthTimeout = healthTimeoutMs; this.#coordinator = coordinatorDirectory;
  }
  get #file() {
    return voiceProfileCatalogFile(this.root,path.dirname(this.#configPath));
  }
  #base() {
    const base = resolveDaniaConfig({ configPath: this.#configPath });
    if (this.#baseUrl !== undefined && base.baseUrl !== this.#baseUrl) throw fail('VOICE_PROFILE_ENDPOINT_CHANGED');
    return base;
  }
  #locked(operation, signal, queueTimeoutMs = 0) {
    if (!queueTimeoutMs) return withVoiceOperation(this.#base(), operation, { signal, coordinatorDirectory: this.#coordinator });
    const base = this.#base(); active(signal);
    const waiting = new AbortController();
    const timer = setTimeout(() => waiting.abort(), queueTimeoutMs);
    let pending;
    try {
      const queuedSignal = signal ? AbortSignal.any([signal, waiting.signal]) : waiting.signal;
      pending = withVoiceOperation(base, context => {
        clearTimeout(timer);
        return operation(context);
      }, { signal: queuedSignal, coordinatorDirectory: this.#coordinator });
    } catch (failure) { clearTimeout(timer); throw failure; }
    return pending.catch(failure => {
      if (waiting.signal.aborted && !signal?.aborted) throw fail('VOICE_OPERATION_BUSY');
      throw failure;
    }).finally(() => clearTimeout(timer));
  }
  #validate(config, { checkFiles = true } = {}) {
    if (!object(config) || Object.keys(config).some(key => !fields.includes(key))) throw fail('VOICE_PROFILE_CONFIG_INVALID');
    const base = this.#base(), selected = {};
    for (const key of fields) selected[key] = config[key] ?? base[key] ?? DANIA_DEFAULTS[key];
    let normalized;
    try { normalized = new VoiceSynthesisClient({ config: { ...base, ...selected } }).config; }
    catch { throw fail('VOICE_PROFILE_CONFIG_INVALID'); }
    for (const key of fields) selected[key] = normalized[key];
    if (!languages.has(selected.promptLang) || !languages.has(selected.textLang)) throw fail('VOICE_PROFILE_LANGUAGE_UNSUPPORTED');
    for (const key of Object.keys(extensions)) {
      const full = path.resolve(base.paths.root, selected[key]);
      if (!extensions[key].has(path.extname(full).toLowerCase())) throw fail('VOICE_PROFILE_EXTENSION_INVALID', { field: key });
      if (!this.#modelRoots.some(root => inside(root, full))) throw fail('VOICE_PROFILE_PATH_OUTSIDE_ROOT', { field: key });
      if (checkFiles) {
        try {
          const actual = fs.realpathSync(full);
          if (!this.#modelRoots.some(root => inside(root, actual))) throw fail('VOICE_PROFILE_PATH_OUTSIDE_ROOT', { field: key });
          if (!fs.statSync(actual).isFile() || fs.statSync(actual).size < 1) throw fail('VOICE_PROFILE_FILE_INVALID', { field: key });
          selected[key] = actual;
        } catch (failure) {
          if (failure.code?.startsWith('VOICE_PROFILE_')) throw failure;
          throw fail('VOICE_PROFILE_FILE_MISSING', { field: key });
        }
      } else selected[key] = full;
    }
    return selected;
  }
  #load() {
    if (!fs.existsSync(this.#file)) {
      const base = this.#base(), config = this.#validate(Object.fromEntries(fields.map(key => [key, base[key]])));
      const state = { schema: 1, version: 1, selectedId: 'dania', profiles: [{ id: 'dania', name: '达妮娅', config }], lastApply: null };
      atomicSave(this.#file, state); return state;
    }
    const state = boundedJson(this.#file);
    if (!object(state) || state.schema !== 1 || !Number.isSafeInteger(state.version) || state.version < 1 || !Array.isArray(state.profiles) || state.profiles.length < 1 || state.profiles.length > 64) throw fail('VOICE_PROFILES_STORAGE_INVALID');
    const ids = new Set();
    for (const profile of state.profiles) {
      if (!object(profile) || typeof profile.id !== 'string' || !idPattern.test(profile.id) || ids.has(profile.id) || typeof profile.name !== 'string' || !profile.name.trim() || profile.name.length > 80 || /[\0\r\n]/.test(profile.name) || !object(profile.config) || fields.some(key => !Object.hasOwn(profile.config, key) || profile.config[key] === null)) throw fail('VOICE_PROFILES_STORAGE_INVALID');
      ids.add(profile.id); profile.config = this.#validate(profile.config, { checkFiles: false });
    }
    if (!ids.has('dania') || !ids.has(state.selectedId)) throw fail('VOICE_PROFILES_STORAGE_INVALID');
    return state;
  }
  #acknowledged(state, serviceState) {
    const profile = state.profiles.find(item => item.id === state.selectedId), last = state.lastApply;
    const hash = fingerprint(profile.config);
    return serviceState.status === 'acknowledged' && serviceState.fingerprint === hash &&
      last?.status === 'acknowledged' && last.profileId === state.selectedId && last.fingerprint === hash;
  }
  #matchesEpoch(state, serviceState, epoch) {
    return validEpoch(epoch) && this.#acknowledged(state, serviceState) &&
      serviceState.appliedServiceEpoch === epoch && state.lastApply.serviceEpoch === epoch;
  }
  #view(state, serviceState, applied = false, { currentServiceMatched = false, reused = false } = {}) {
    const unknown = ['unknown', 'applying'].includes(serviceState.status);
    const loadAcknowledged = !unknown && this.#acknowledged(state, serviceState);
    return { version: state.version, selectedId: state.selectedId, profiles: structuredClone(state.profiles),
      status: unknown ? 'unknown' : applied ? 'acknowledged' : 'pending', applied: applied && !unknown,
      loadAcknowledged, currentServiceMatched: currentServiceMatched && !unknown, reused,
      verification: applied ? 'api-acknowledged' : loadAcknowledged ? 'historical-api-acknowledged' : 'not-currently-verified', lastApply: state.lastApply ? structuredClone(state.lastApply) : null,
      reason: unknown ? 'VOICE_MODEL_STATE_UNKNOWN' : null };
  }
  async snapshot() {
    if (!fs.existsSync(this.#file)) return this.#locked(context => this.#view(this.#load(), context.readState()), undefined, 10000);
    // Reading status must not wait behind synthesis or mutate either model.
    // A historical acknowledgement becomes current only after a compatible
    // service-instance probe and a fresh read of the selected profile/barrier.
    let state = this.#load(), service = readVoiceOperationState(this.#base(), { coordinatorDirectory: this.#coordinator });
    let epoch;
    if (this.#matchesEpoch(state, service, service.appliedServiceEpoch)) {
      try { epoch = await this.#serviceEpoch(); } catch {}
      state = this.#load(); service = readVoiceOperationState(this.#base(), { coordinatorDirectory: this.#coordinator });
    }
    const matched = this.#matchesEpoch(state, service, epoch);
    return this.#view(state, service, matched, { currentServiceMatched: matched });
  }
  #cas(state, expectedVersion) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== state.version) throw fail('VOICE_PROFILE_VERSION_CONFLICT', { version: state.version });
  }
  #saveProfile(state,{id,name,config}) {
    id ??= 'voice-' + crypto.randomBytes(8).toString('hex');
    if (typeof id !== 'string' || !idPattern.test(id) || typeof name !== 'string' || !name.trim() || name.length > 80 || /[\0\r\n]/.test(name)) throw fail('VOICE_PROFILE_INVALID');
    const normalized = this.#validate(config), existing = state.profiles.findIndex(profile => profile.id === id);
    if (existing < 0 && state.profiles.length >= 64) throw fail('VOICE_PROFILE_LIMIT');
    if (id === 'dania') throw fail('VOICE_PROFILE_DANIA_READ_ONLY');
    const profile={id,name:name.trim(),config:normalized};
    if (existing < 0) state.profiles.push(profile);
    else state.profiles[existing] = profile;
    return id;
  }
  async save({expectedVersion,id,name,config,signal}={}) {
    return this.#locked(context => {
      const state = this.#load(); this.#cas(state,expectedVersion);
      id=this.#saveProfile(state,{id,name,config});
      if (state.selectedId === id) {
        const service = context.readState();
        context.writeState({ ...service, managed: true, status: ['unknown', 'applying'].includes(service.status) ? service.status : 'pending' });
        state.lastApply = null;
      }
      state.version++; atomicSave(this.#file, state);
      return { ...this.#view(state, context.readState()), savedId: id };
    }, signal, 10000);
  }
  /** The voice operation lock spans validation through the provider-file
   * commit. Existing voice writers, loads, and synthesis use this same lock. */
  async saveSpeechSelection(providerRequest, localVoice) {
    if (!object(localVoice) || Object.keys(localVoice).some(key=>!['expectedVersion','id','name','config'].includes(key))) throw fail('VOICE_PROFILE_INVALID');
    const editing=Object.hasOwn(localVoice,'config');
    if(editing!==Object.hasOwn(localVoice,'name')||(!editing&&typeof localVoice.id!=='string')) throw fail('VOICE_PROFILE_INVALID');
    return this.#locked(context=>{
      const state=this.#load();
      this.#cas(state,localVoice.expectedVersion);
      if(state.version===Number.MAX_SAFE_INTEGER)throw fail('VOICE_PROFILES_STORAGE_INVALID');
      const existing=state.profiles.find(row=>row.id===localVoice.id);
      if(Object.hasOwn(localVoice,'id')&&!existing)throw fail('VOICE_PROFILE_NOT_FOUND');
      const id=editing?this.#saveProfile(state,localVoice):existing.id;
      if(!editing)this.#validate(existing.config);
      const selected=state.profiles.find(profile=>profile.id===id);
      const wasCurrent=state.selectedId===id&&state.lastApply?.fingerprint===fingerprint(selected.config);
      if(!wasCurrent)state.lastApply=null;
      state.selectedId=id;
      state.version++;
      const voice=this.#view(state,context.readState());
      const providers=saveSpeechProviders({root:this.root},providerRequest,slot=>{
        atomicSave(voiceProfileCatalogFile(this.root,path.dirname(this.#configPath),slot),state);
      });
      return {...providers,voice};
    },undefined,10000);
  }
  async select({ expectedVersion, id, apply = true, signal } = {}) {
    if (typeof apply !== 'boolean') throw fail('VOICE_PROFILE_OPTIONS_INVALID');
    return this.#locked(async context => {
      const state = this.#load(); this.#cas(state, expectedVersion);
      const profile = state.profiles.find(item => item.id === id);
      if (!profile) throw fail('VOICE_PROFILE_NOT_FOUND');
      profile.config = this.#validate(profile.config);
      const service = context.readState();
      if (apply && id === state.selectedId) return this.#apply(state, context, signal);
      context.writeState({ ...service, managed: true, status: ['unknown', 'applying'].includes(service.status) ? service.status : 'pending' });
      state.selectedId = id; state.version++; state.lastApply = null; atomicSave(this.#file, state);
      return apply ? this.#apply(state, context, signal) : this.#view(state, context.readState());
    }, signal, 10000);
  }
  async applySelected({ signal } = {}) {
    return this.#locked(context => this.#apply(this.#load(), context, signal), signal);
  }
  async #json(url, { timeout, signal } = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let response, reader;
    try {
      active(signal);
      response = await this.#fetch(url, { method: 'GET', redirect: 'error', signal: combined, headers: { Accept: 'application/json' } });
      if (!response.ok) throw fail('VOICE_MODEL_API_REJECTED');
      if (!response.body) throw fail('VOICE_MODEL_API_INVALID');
      reader = response.body.getReader(); const chunks = []; let size = 0;
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 256 * 1024) throw fail('VOICE_MODEL_API_INVALID');
        chunks.push(Buffer.from(value));
      }
      active(signal); if (controller.signal.aborted) throw fail('VOICE_MODEL_API_TIMEOUT');
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('VOICE_MODEL_API_INVALID'); }
    } catch (failure) {
      if (signal?.aborted) throw fail('VOICE_ABORTED');
      if (controller.signal.aborted) throw fail('VOICE_MODEL_API_TIMEOUT');
      if (failure.code?.startsWith('VOICE_')) throw failure;
      throw fail('VOICE_MODEL_UNAVAILABLE');
    } finally {
      clearTimeout(timer); controller.abort();
      try { if (reader) await reader.cancel(); else await response?.body?.cancel(); } catch {}
      reader?.releaseLock();
    }
  }
  async #apply(state, context, signal) {
    const service = context.readState();
    if (['unknown', 'applying'].includes(service.status)) return this.#view(state, service);
    const profile = state.profiles.find(item => item.id === state.selectedId);
    const config = this.#validate(profile.config), base = this.#base();
    const hash = fingerprint(config);
    let epoch;
    try {
      epoch = await this.#serviceEpoch(signal);
    } catch (failure) {
      state.lastApply = { profileId: profile.id, status: 'pending', reason: failure.code, attemptedAt: new Date().toISOString() };
      atomicSave(this.#file, state);
      return this.#view(state, service);
    }
    active(signal);
    if (service.fingerprint === hash && this.#matchesEpoch(state, service, epoch)) {
      return this.#view(state, service, true, { currentServiceMatched: true, reused: true });
    }
    // Before sending either non-atomic mutation, persist the uncertainty barrier.
    context.writeState({ ...service, managed: true, status: 'applying', fingerprint: hash, appliedServiceEpoch: epoch });
    state.lastApply = { profileId: profile.id, status: 'applying', attemptedAt: new Date().toISOString() };
    atomicSave(this.#file, state);
    try {
      for (const [endpoint, field, parameter] of [['/set_gpt_weights', 'gptWeights', 'weights_path'], ['/set_sovits_weights', 'sovitsWeights', 'weights_path'], ['/set_refer_audio', 'refAudio', 'refer_audio_path']]) {
        const url = new URL(endpoint, base.baseUrl); url.searchParams.set(parameter, config[field]);
        const reply = await this.#json(url.href, { timeout: this.#timeout, signal });
        if (reply?.message !== 'success') throw fail('VOICE_MODEL_API_INVALID');
      }
      active(signal);
      state.lastApply = { ...state.lastApply, status: 'acknowledged', acknowledgedAt: new Date().toISOString(), fingerprint: hash, serviceEpoch: epoch, verification: 'api-acknowledged' };
      atomicSave(this.#file, state);
      context.writeState({ ...service, managed: true, status: 'acknowledged', fingerprint: hash, appliedServiceEpoch: epoch });
      return this.#view(state, context.readState(), true, { currentServiceMatched: validEpoch(epoch) });
    } catch (failure) {
      context.writeState({ ...service, managed: true, status: 'unknown', fingerprint: hash });
      state.lastApply = { ...state.lastApply, status: 'unknown', reason: /^VOICE_[A-Z_]+$/.test(failure?.code ?? '') ? failure.code : 'VOICE_MODEL_STATE_UNKNOWN' };
      atomicSave(this.#file, state);
      return this.#view(state, context.readState());
    }
  }
  async #serviceEpoch(signal) {
    const schema = await this.#json(this.#base().baseUrl + '/openapi.json', { timeout: this.#healthTimeout, signal });
    if (!schema?.paths?.['/tts']?.post || !schema?.paths?.['/set_gpt_weights']?.get || !schema?.paths?.['/set_sovits_weights']?.get || !schema?.paths?.['/set_refer_audio']?.get) throw fail('VOICE_MODEL_SWITCH_UNSUPPORTED');
    // The launcher adapter resets reference features explicitly. Its epoch
    // identifies the service instance, not an inspection of loaded weights.
    const adapter = schema['x-wechatagent-voice-profiles'];
    if (adapter?.version !== 1 || adapter.referenceCacheReset !== true) throw fail('VOICE_MODEL_PROFILE_ADAPTER_REQUIRED');
    if (!validEpoch(adapter.serviceEpoch)) throw fail('VOICE_SERVICE_EPOCH_INVALID');
    return adapter.serviceEpoch;
  }
  createSynthesisClient(options = {}) {
    if ('prepareConfig' in options || 'config' in options || 'coordinatorDirectory' in options) throw fail('VOICE_PROFILE_OPTIONS_INVALID');
    const base = this.#base();
    return new VoiceSynthesisClient({ ...options, config: base, fetchImpl: options.fetchImpl ?? this.#fetch, coordinatorDirectory: this.#coordinator,
      prepareConfig: async ({ signal, context }) => {
        const state = this.#load(), service = context.readState();
        if (['unknown','applying'].includes(service.status)) throw fail('VOICE_MODEL_STATE_UNKNOWN');
        if (!this.#acknowledged(state,service) || !this.#matchesEpoch(state,service,await this.#serviceEpoch(signal)))
          throw fail('VOICE_MODEL_NOT_APPLIED');
        const profile = state.profiles.find(item => item.id === state.selectedId);
        const config = this.#validate(profile.config);
        return { config: { ...base, ...config, modelId: profile.id }, modelVerification: 'api-acknowledged' };
      } });
  }
  async discover() {
    const result = { root: this.#modelRoots[0], roots: [...this.#modelRoots], gptWeights: [], sovitsWeights: [], refAudio: [], truncated: false };
    let visited = 0;
    const walk = (directory, depth) => {
      if (++visited > 12000 || depth > 10) { result.truncated = true; return; }
      let entries;
      try {
        if (fs.lstatSync(directory).isSymbolicLink() || !this.#modelRoots.some(root => inside(root, fs.realpathSync(directory)))) { result.truncated = true; return; }
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch { result.truncated = true; return; }
      for (const entry of entries) {
        if (++visited > 12000) { result.truncated = true; return; }
        if (entry.isSymbolicLink() || ['.git', '__pycache__', 'node_modules', 'venv', '.venv'].includes(entry.name)) continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile()) for (const [kind, accepted] of Object.entries(extensions)) {
          if (accepted.has(path.extname(entry.name).toLowerCase())) {
            try {
              const real = fs.realpathSync(full);
              if (!this.#modelRoots.some(root => inside(root, real)) || fs.statSync(real).size < 1) continue;
              if (result[kind].length >= 500) result.truncated = true;
              else if (!result[kind].includes(real)) result[kind].push(real);
            } catch { result.truncated = true; }
          }
        }
      }
    };
    for (const root of this.#modelRoots) walk(root, 0);
    for (const key of Object.keys(extensions)) result[key].sort((a, b) => a.localeCompare(b));
    return result;
  }
}

export const createVoiceProfiles = options => new VoiceProfileStore(options);
