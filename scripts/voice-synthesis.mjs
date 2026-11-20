import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// Request defaults match dsh-dania-voice 1.0.2 (MIT), commit 27b29c16.
// This client never starts a model server, plays audio, or sends a WeChat
// message. A profile manager may provide a preparation hook under the shared
// service lock. Otherwise model identifiers describe caller configuration;
// they are not evidence of the weights loaded by the external service.
export const DANIA_DEFAULTS = Object.freeze({
  baseUrl: 'http://127.0.0.1:9880', installDir: '', root: '', pythonPath: '',
  refAudio: 'output/slicer_opt/output.wav_0009342720_0009558400.wav',
  promptText: '怎么啊？如果有你在也不放心，那就干脆给我也装个限制器或者炸弹喽。',
  promptLang: 'zh', textLang: 'zh', speed: 1, temperature: 0.7, topK: 10,
  topP: 0.9, repetitionPenalty: 1.35, fragmentInterval: 0.4, textSplitMethod: 'cut2',
  modelId: 'dania-v2ProPlus', gptWeights: 'GPT_SoVITS/dania-e15.ckpt',
  sovitsWeights: 'GPT_SoVITS/dania_e16_s2192.pth',
});
const error = (code, details = {}) => Object.assign(new Error(code), { code, ...details });
const defaultHome = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function textField(value, name, max = 2048, empty = false, multiline = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || (multiline ? /\0/ : /[\0\r\n]/).test(value)) throw error('VOICE_CONFIG_INVALID', { field: name });
  return value;
}
function numberField(value, name, low, high, integer = false) {
  if (!Number.isFinite(value) || value < low || value > high || (integer && !Number.isInteger(value))) throw error('VOICE_CONFIG_INVALID', { field: name });
  return value;
}
function localBase(value) {
  let url;
  try { url = new URL(textField(value, 'baseUrl')); } catch { throw error('VOICE_LOOPBACK_REQUIRED'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port === '0') throw error('VOICE_LOOPBACK_REQUIRED');
  return url.origin;
}
function normalizeConfig(raw, { dshHome = defaultHome(), configPath = null } = {}) {
  if (!object(raw)) throw error('VOICE_CONFIG_INVALID');
  const config = {};
  for (const [key, fallback] of Object.entries(DANIA_DEFAULTS)) config[key] = raw[key] ?? fallback;
  config.baseUrl = localBase(config.baseUrl);
  for (const key of ['installDir', 'root', 'pythonPath']) textField(config[key], key, 2048, true);
  for (const key of ['refAudio', 'gptWeights', 'sovitsWeights']) textField(config[key], key);
  for (const key of ['promptLang', 'textLang']) {
    if (!/^[a-z_]{1,32}$/.test(textField(config[key], key, 32))) throw error('VOICE_CONFIG_INVALID', { field: key });
  }
  textField(config.promptText, 'promptText', 4000, true, true);
  textField(config.modelId, 'modelId', 128);
  if (!/^cut[0-5]$/.test(config.textSplitMethod)) throw error('VOICE_CONFIG_INVALID', { field: 'textSplitMethod' });
  for (const [key, low, high, integer] of [
    ['speed', 0.5, 2], ['temperature', 0.05, 2], ['topK', 1, 100, true],
    ['topP', 0.05, 1], ['repetitionPenalty', 1, 2], ['fragmentInterval', 0, 2],
  ]) numberField(config[key], key, low, high, integer);
  config.dshHome = path.resolve(textField(dshHome, 'dshHome'));
  config.configPath = configPath;
  const installDir = config.installDir.trim() ? path.resolve(config.dshHome, config.installDir) : path.join(config.dshHome, 'dania-voice');
  const root = config.root.trim() ? path.resolve(installDir, config.root) : path.join(installDir, 'gpt-sovits');
  config.paths = Object.freeze({
    installDir, root,
    pythonPath: config.pythonPath.trim() ? path.resolve(installDir, config.pythonPath) : path.join(installDir, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    refAudio: path.resolve(root, config.refAudio),
    gptWeights: path.resolve(root, config.gptWeights), sovitsWeights: path.resolve(root, config.sovitsWeights),
  });
  return Object.freeze(config);
}

/** Defaults < config JSON < explicit overrides. installDir never moves config discovery. */
export function resolveDaniaConfig({ dshHome = defaultHome(), configPath, overrides = {} } = {}) {
  const home = path.resolve(textField(dshHome, 'dshHome'));
  const file = configPath === undefined ? path.join(home, 'dania-voice', 'config.json') : path.resolve(textField(configPath, 'configPath'));
  let saved = {};
  if (fs.existsSync(file)) {
    try {
      if (!fs.statSync(file).isFile() || fs.statSync(file).size > 65536) throw error('VOICE_CONFIG_INVALID');
      const bytes = fs.readFileSync(file);
      if (bytes.length > 65536) throw error('VOICE_CONFIG_INVALID');
      saved = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    } catch { throw error('VOICE_CONFIG_INVALID'); }
    if (!object(saved)) throw error('VOICE_CONFIG_INVALID');
  } else if (configPath !== undefined) throw error('VOICE_CONFIG_NOT_FOUND');
  if (!object(overrides)) throw error('VOICE_CONFIG_INVALID');
  return normalizeConfig({ ...saved, ...overrides }, { dshHome: home, configPath: file });
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** Preserve every character; oversized input fails instead of silently truncating. */
export function splitVoiceText(text, { segmentChars = 90, maxTextChars = 4000 } = {}) {
  numberField(segmentChars, 'segmentChars', 1, 90, true);
  numberField(maxTextChars, 'maxTextChars', 1, 4000, true);
  if (typeof text !== 'string' || !text.trim() || !text.isWellFormed() || /\0/.test(text)) throw error('VOICE_TEXT_INVALID');
  if (text.length > maxTextChars * 2 || Array.from(text).length > maxTextChars) throw error('VOICE_TEXT_TOO_LONG');
  const units = Array.from(graphemes.segment(text), part => ({ text: part.segment, length: Array.from(part.segment).length }));
  const result = [];
  for (let start = 0; start < units.length;) {
    let end = start, count = 0, boundary = -1;
    while (end < units.length && count + units[end].length <= segmentChars) {
      count += units[end].length;
      if (/[。！？!?；;\n]/u.test(units[end].text) && count >= segmentChars / 2) boundary = end + 1;
      end++;
    }
    if (end === start) throw error('VOICE_GRAPHEME_TOO_LONG');
    if (end < units.length && boundary > start) end = boundary;
    const segment = units.slice(start, end).map(part => part.text).join('');
    if (!segment.trim()) throw error('VOICE_WHITESPACE_SEGMENT');
    result.push(segment); start = end;
  }
  return result;
}

/** Validate the complete RIFF container and uncompressed WAV geometry. */
export function inspectWav(input) {
  const buffer = Buffer.isBuffer(input) ? input : input instanceof Uint8Array ? Buffer.from(input.buffer, input.byteOffset, input.byteLength) : null;
  const invalid = () => { throw error('VOICE_WAV_INVALID'); };
  if (!buffer || buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE' || buffer.readUInt32LE(4) + 8 !== buffer.length) invalid();
  let offset = 12, format, dataBytes;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) invalid();
    const tag = buffer.toString('ascii', offset, offset + 4), size = buffer.readUInt32LE(offset + 4), begin = offset + 8, end = begin + size;
    if (end + (size & 1) > buffer.length) invalid();
    if (tag === 'fmt ') {
      if (format || size < 16) invalid();
      const encoding = buffer.readUInt16LE(begin), channels = buffer.readUInt16LE(begin + 2), sampleRate = buffer.readUInt32LE(begin + 4), byteRate = buffer.readUInt32LE(begin + 8), blockAlign = buffer.readUInt16LE(begin + 12), bitsPerSample = buffer.readUInt16LE(begin + 14);
      if (![1, 3].includes(encoding) || channels < 1 || channels > 8 || sampleRate < 8000 || sampleRate > 192000 ||
          !(encoding === 1 ? [8, 16, 24, 32] : [32, 64]).includes(bitsPerSample) || blockAlign !== channels * bitsPerSample / 8 || byteRate !== sampleRate * blockAlign) invalid();
      format = { encoding: encoding === 1 ? 'pcm' : 'float', channels, sampleRate, bitsPerSample, blockAlign, byteRate };
    } else if (tag === 'data') {
      if (dataBytes !== undefined || !size) invalid();
      dataBytes = size;
    }
    offset = end + (size & 1);
  }
  if (!format || dataBytes === undefined || dataBytes % format.blockAlign) invalid();
  return Object.freeze({ ...format, dataBytes, sampleFrames: dataBytes / format.blockAlign, durationMs: dataBytes / format.byteRate * 1000 });
}

function assertActive(signal) { if (signal?.aborted) throw error('VOICE_ABORTED'); }
function cancellableWait(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(error('VOICE_ABORTED')); };
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(value => { signal.removeEventListener('abort', aborted); resolve(value); }, failure => { signal.removeEventListener('abort', aborted); reject(failure); });
    if (signal.aborted) aborted();
  });
}

// The complete reply (all segments) and both weight-loading requests share
// this endpoint lock, including separate Node processes. A crashed owner is
// never silently stolen: the server-start path can reset it after a new server
// has actually been launched on the previously unused port.
const voiceTails = new Map();
const defaultCoordinator = path.join(os.tmpdir(), 'wechatagent-voice-operations');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function coordinatorFiles(config, directory = defaultCoordinator) {
  const baseUrl = localBase(config.baseUrl ?? DANIA_DEFAULTS.baseUrl);
  const key = crypto.createHash('sha256').update(baseUrl).digest('hex');
  const root = path.resolve(directory);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(root).isSymbolicLink()) throw error('VOICE_OPERATION_STORAGE_INVALID');
  return { key: baseUrl, lock: path.join(root, key + '.lock'), state: path.join(root, key + '.json') };
}
function operationState(file) {
  if (!fs.existsSync(file)) return { version: 1, managed: false, status: 'unmanaged' };
  try {
    if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 8192) throw 0;
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state.version !== 1 || typeof state.managed !== 'boolean' || !['unmanaged', 'pending', 'applying', 'acknowledged', 'unknown'].includes(state.status) || (state.status !== 'unmanaged' && !state.managed)) throw 0;
    return state;
  } catch { throw error('VOICE_OPERATION_STORAGE_INVALID'); }
}
function writeOperationState(file, state) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  let fd;
  try { fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify({ ...state, version: 1 })); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(temp, file); }
  catch { throw error('VOICE_OPERATION_STORAGE_FAILED'); }
  finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
}
function liveProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw error('VOICE_OPERATION_STORAGE_INVALID');
  try { process.kill(pid, 0); return true; } catch (failure) { return failure.code !== 'ESRCH'; }
}
async function acquireOperation(files, signal) {
  const token = crypto.randomUUID(), deadline = Date.now() + 600000;
  for (;;) {
    assertActive(signal);
    try {
      fs.writeFileSync(files.lock, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
      return () => {
        let owner;
        try { owner = JSON.parse(fs.readFileSync(files.lock, 'utf8')); } catch { throw error('VOICE_OPERATION_RELEASE_FAILED'); }
        if (owner.token !== token || owner.pid !== process.pid) throw error('VOICE_OPERATION_RELEASE_FAILED');
        fs.unlinkSync(files.lock);
      };
    } catch (failure) {
      if (failure.code !== 'EEXIST') throw error('VOICE_OPERATION_STORAGE_FAILED');
      let owner;
      try { if (fs.lstatSync(files.lock).isSymbolicLink() || fs.statSync(files.lock).size > 1024) throw 0; owner = JSON.parse(fs.readFileSync(files.lock, 'utf8')); }
      catch { throw error('VOICE_OPERATION_RECOVERY_REQUIRED'); }
      if (!liveProcess(owner.pid)) throw error('VOICE_OPERATION_RECOVERY_REQUIRED');
      if (Date.now() >= deadline) throw error('VOICE_OPERATION_BUSY');
      await sleep(25);
    }
  }
}
export function withVoiceOperation(config, operation, { signal, coordinatorDirectory } = {}) {
  assertActive(signal);
  const files = coordinatorFiles(config, coordinatorDirectory);
  const pending = (voiceTails.get(files.key) ?? Promise.resolve()).then(async () => {
    assertActive(signal);
    const release = await acquireOperation(files, signal);
    try { assertActive(signal); return await operation({ readState: () => operationState(files.state), writeState: state => writeOperationState(files.state, state) }); }
    finally { release(); }
  });
  const tail = pending.catch(() => {}); voiceTails.set(files.key, tail);
  tail.finally(() => { if (voiceTails.get(files.key) === tail) voiceTails.delete(files.key); });
  return cancellableWait(pending, signal);
}

export function readVoiceOperationState(config, { coordinatorDirectory } = {}) {
  return operationState(coordinatorFiles(config, coordinatorDirectory).state);
}

/** Only the supervisor may call this after starting a new owned service on a
 * port it proved unused. Ordinary profile selection must not clear unknowns. */
export async function resetVoiceOperationAfterServerStart(config, { serviceEpoch, coordinatorDirectory, signal, ownsLiveServer } = {}) {
  if (typeof serviceEpoch !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(serviceEpoch)) throw error('VOICE_SERVICE_EPOCH_INVALID');
  if (typeof ownsLiveServer !== 'function') throw error('VOICE_SERVICE_OWNERSHIP_REQUIRED');
  assertActive(signal);
  const files = coordinatorFiles(config, coordinatorDirectory);
  if (fs.existsSync(files.lock)) {
    let owner;
    try { if (fs.lstatSync(files.lock).isSymbolicLink() || fs.statSync(files.lock).size > 1024) throw 0; owner = JSON.parse(fs.readFileSync(files.lock, 'utf8')); }
    catch { throw error('VOICE_OPERATION_RECOVERY_REQUIRED'); }
    if (!liveProcess(owner.pid)) { assertActive(signal); fs.unlinkSync(files.lock); }
  }
  return withVoiceOperation(config, async context => {
    assertActive(signal);
    let owned;
    try { owned = await ownsLiveServer({ serviceEpoch, signal }); }
    catch { assertActive(signal); throw error('VOICE_SERVICE_NOT_CURRENT'); }
    assertActive(signal);
    if (owned !== true) throw error('VOICE_SERVICE_NOT_CURRENT');
    const previous = context.readState();
    if (previous.serviceEpoch === serviceEpoch) throw error('VOICE_SERVICE_EPOCH_REUSED');
    assertActive(signal);
    context.writeState({ managed: true, status: 'pending', serviceEpoch });
  }, { coordinatorDirectory, signal });
}

export class VoiceSynthesisClient {
  #prepareConfig;
  #coordinatorDirectory;
  constructor({ config = resolveDaniaConfig(), timeoutMs = 120000, maxResponseBytes = 16 * 1024 * 1024, maxTotalBytes = 64 * 1024 * 1024, fetchImpl = fetch, prepareConfig, coordinatorDirectory } = {}) {
    this.config = normalizeConfig(config, { dshHome: config.dshHome, configPath: config.configPath ?? null });
    this.timeoutMs = numberField(timeoutMs, 'timeoutMs', 1, 600000, true);
    this.maxResponseBytes = numberField(maxResponseBytes, 'maxResponseBytes', 44, 64 * 1024 * 1024, true);
    this.maxTotalBytes = numberField(maxTotalBytes, 'maxTotalBytes', 44, 128 * 1024 * 1024, true);
    if (typeof fetchImpl !== 'function') throw error('VOICE_CONFIG_INVALID', { field: 'fetchImpl' });
    if (prepareConfig !== undefined && typeof prepareConfig !== 'function') throw error('VOICE_CONFIG_INVALID', { field: 'prepareConfig' });
    this.#prepareConfig = prepareConfig; this.#coordinatorDirectory = coordinatorDirectory;
    this.configurationMode = prepareConfig ? 'prepared-per-job' : 'fixed';
    this.fetchImpl = fetchImpl;
    this.voiceId = crypto.createHash('sha256').update(JSON.stringify({ ...Object.fromEntries(Object.keys(DANIA_DEFAULTS).map(key => [key, this.config[key]])), paths: this.config.paths })).digest('hex');
    Object.freeze(this);
  }
  #enqueue(operation, signal) {
    return withVoiceOperation(this.config, async context => {
      assertActive(signal);
      if (!this.#prepareConfig && context.readState().managed) throw error('VOICE_PROFILE_CLIENT_REQUIRED');
      const prepared = this.#prepareConfig ? await this.#prepareConfig({ signal, context }) : { config: this.config, modelVerification: 'caller-configured' };
      const cfg = normalizeConfig(prepared.config, { dshHome: prepared.config.dshHome, configPath: prepared.config.configPath ?? null });
      if (cfg.baseUrl !== this.config.baseUrl) throw error('VOICE_PROFILE_ENDPOINT_CHANGED');
      const voiceId = crypto.createHash('sha256').update(JSON.stringify({ ...Object.fromEntries(Object.keys(DANIA_DEFAULTS).map(key => [key, cfg[key]])), paths: cfg.paths })).digest('hex');
      return operation({ config: cfg, voiceId, modelVerification: prepared.modelVerification });
    }, { signal, coordinatorDirectory: this.#coordinatorDirectory });
  }
  async synthesizeSegment(text, { signal } = {}) {
    const segments = splitVoiceText(text);
    if (segments.length !== 1) throw error('VOICE_SEGMENT_TOO_LONG');
    return this.#enqueue(job => this.#request(text, signal, Math.min(this.maxResponseBytes, this.maxTotalBytes), job), signal);
  }
  async synthesize(text, { signal } = {}) {
    const texts = splitVoiceText(text);
    return this.#enqueue(async job => {
      const segments = []; let bytes = 0, durationMs = 0;
      for (const part of texts) {
        assertActive(signal);
        const budget = Math.min(this.maxResponseBytes, this.maxTotalBytes - bytes);
        if (budget < 44) throw error('VOICE_AUDIO_TOO_LARGE');
        const segment = await this.#request(part, signal, budget, job);
        segments.push(segment); bytes += segment.audio.length; durationMs += segment.durationMs;
      }
      return { segments, durationMs, voiceId: job.voiceId, modelId: job.config.modelId, modelVerification: job.modelVerification };
    }, signal);
  }
  async #request(text, signal, limit, job) {
    assertActive(signal);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let response, reader;
    try {
      const cfg = job.config;
      response = await this.fetchImpl(cfg.baseUrl + '/tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: combined,
        body: JSON.stringify({ text, text_lang: cfg.textLang, ref_audio_path: cfg.refAudio, prompt_text: cfg.promptText,
          prompt_lang: cfg.promptLang, text_split_method: cfg.textSplitMethod, media_type: 'wav', streaming_mode: false,
          speed_factor: cfg.speed, batch_size: 1, parallel_infer: true, repetition_penalty: cfg.repetitionPenalty,
          temperature: cfg.temperature, top_k: cfg.topK, top_p: cfg.topP, fragment_interval: cfg.fragmentInterval }),
      });
      if (!response.ok) throw error('VOICE_HTTP_ERROR', { status: response.status });
      const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!['audio/wav', 'audio/wave', 'audio/x-wav', 'application/octet-stream'].includes(type)) throw error('VOICE_AUDIO_TYPE_INVALID');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw error('VOICE_AUDIO_TOO_LARGE');
      if (!response.body) throw error('VOICE_WAV_INVALID');
      reader = response.body.getReader();
      const chunks = []; let bytes = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) throw error('VOICE_AUDIO_TOO_LARGE');
        chunks.push(Buffer.from(value));
      }
      assertActive(signal);
      if (controller.signal.aborted) throw error('VOICE_TIMEOUT');
      const audio = Buffer.concat(chunks, bytes), format = inspectWav(audio);
      return { text, audio, format, durationMs: format.durationMs, voiceId: job.voiceId, modelVerification: job.modelVerification };
    } catch (failure) {
      if (signal?.aborted) throw error('VOICE_ABORTED');
      if (controller.signal.aborted) throw error('VOICE_TIMEOUT');
      if (typeof failure?.code === 'string' && failure.code.startsWith('VOICE_')) throw failure;
      throw error('VOICE_NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
      controller.abort();
      try { if (reader) await reader.cancel(); else await response?.body?.cancel(); } catch {}
      reader?.releaseLock();
    }
  }
}
