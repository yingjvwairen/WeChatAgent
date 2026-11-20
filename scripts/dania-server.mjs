import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveDaniaConfig, resetVoiceOperationAfterServerStart } from './voice-synthesis.mjs';
import { VoiceProfileStore } from './voice-profiles.mjs';

const fault = code => Object.assign(new Error(code), { code });
const active = signal => { if (signal?.aborted) throw fault('VOICE_SERVICE_ABORTED'); };
const localPath = file => {
  if (!path.isAbsolute(file) || /^[/\\]{2}/.test(file)) throw fault('VOICE_SERVICE_LOCAL_PATH_REQUIRED');
  return file;
};
function noLinks(file) {
  for (let at = path.resolve(file);; at = path.dirname(at)) {
    if (fs.lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('VOICE_SERVICE_LINK_REFUSED');
    if (path.dirname(at) === at) return;
  }
}
export function voiceServiceFiles(root) {
  const directory = path.join(root, 'state/dania-voice');
  return { directory, configPath: path.join(directory, 'config.json'), lock: path.join(directory, 'service.lock'), state: path.join(directory, 'runtime-state.json') };
}
export function voiceServiceSchema(schema) {
  return schema?.paths?.['/tts']?.post !== undefined && schema.paths?.['/set_gpt_weights']?.get !== undefined &&
    schema.paths?.['/set_sovits_weights']?.get !== undefined && schema.paths?.['/set_refer_audio']?.get !== undefined &&
    schema['x-wechatagent-voice-profiles']?.version === 1 && schema['x-wechatagent-voice-profiles']?.referenceCacheReset === true;
}
export async function probeVoiceService(config, { signal, fetchImpl = fetch } = {}) {
  active(signal);
  try {
    const response = await fetchImpl(config.baseUrl + '/openapi.json', { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1000)]) : AbortSignal.timeout(1000) });
    if (!response.ok) return { available: false };
    const bytes = await response.text();
    if (bytes.length > 256 * 1024) return { available: true, compatible: false };
    const schema = JSON.parse(bytes);
    return { available: true, compatible: voiceServiceSchema(schema), serviceEpoch: schema?.['x-wechatagent-voice-profiles']?.serviceEpoch };
  } catch { active(signal); return { available: false }; }
}
function assertInstall(config) {
  const url = new URL(config.baseUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw fault('VOICE_SERVICE_LOCAL_IPV4_REQUIRED');
  const api = path.join(config.paths.root, 'api_v2.py'), yaml = path.join(config.paths.root, 'GPT_SoVITS/configs/tts_infer.yaml');
  const modelRoot = fs.realpathSync(localPath(config.paths.root)), python = fs.realpathSync(localPath(config.paths.pythonPath));
  if (!fs.statSync(python).isFile() || process.platform === 'win32' && path.extname(python).toLowerCase() !== '.exe') throw fault('VOICE_SERVICE_PYTHON_INVALID');
  for (const file of [config.paths.refAudio, config.paths.gptWeights, config.paths.sovitsWeights, api, yaml,
    path.join(modelRoot, 'GPT_SoVITS/text/G2PWModel/g2pw.onnx'), path.join(modelRoot, 'GPT_SoVITS/pretrained_models/fast_langdetect/lid.176.bin')]) {
    localPath(file);
    if (!fs.statSync(file).isFile()) throw fault('VOICE_SERVICE_INSTALL_INCOMPLETE');
    const relative = path.relative(modelRoot, fs.realpathSync(file));
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw fault('VOICE_SERVICE_INSTALL_OUTSIDE_ROOT');
  }
  return { python, api, yaml, port: Number(url.port || 80) };
}
async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(fault('VOICE_SERVICE_PORT_IN_USE')));
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}
function bootstrap(serviceEpoch) {
  return `import os, sys, runpy
sys.path.extend([os.getcwd(), os.path.join(os.getcwd(), "GPT_SoVITS")])
from GPT_SoVITS.TTS_infer_pack.TTS import TTS
from fastapi import FastAPI
_original_reference = TTS.set_ref_audio
def _refresh_profile_reference(self, reference_path):
    result = _original_reference(self, reference_path)
    self.prompt_cache["prompt_text"] = None
    self.prompt_cache["prompt_lang"] = None
    return result
TTS.set_ref_audio = _refresh_profile_reference
_original_openapi = FastAPI.openapi
def _profile_openapi(self):
    schema = _original_openapi(self)
    schema["x-wechatagent-voice-profiles"] = {"version": 1, "referenceCacheReset": True, "serviceEpoch": ${JSON.stringify(serviceEpoch)}}
    return schema
FastAPI.openapi = _profile_openapi
_api_path = sys.argv[1]
sys.argv = sys.argv[1:]
runpy.run_path(_api_path, run_name="__main__")
`;
}
function killOwnedTree(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform !== 'win32') { child.kill(); return; }
  const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  // Never fall back to killing by image name or another process's saved PID.
  killer.once('error', () => {});
}

/** Owns exactly the Python child launched here. Importing this module is inert.
 * The manual launcher and automatic sender use this same exclusive lease. */
export async function startDaniaServer({ root = path.resolve(import.meta.dirname, '..'), signal,
  config = resolveDaniaConfig({ configPath: voiceServiceFiles(root).configPath }),
  spawnImpl = spawn, probe = probeVoiceService, validateInstall = assertInstall, checkPort = assertPortAvailable,
  resetService = resetVoiceOperationAfterServerStart, createProfiles = options => new VoiceProfileStore(options), applySelectedAtStart = true,
  killTree = killOwnedTree, timeoutMs = 300000, pollMs = 500, stopTimeoutMs = 10000, onState = () => {} } = {}) {
  active(signal);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(pollMs) || pollMs < 1 || !Number.isInteger(stopTimeoutMs) || stopTimeoutMs < 1) throw fault('VOICE_SERVICE_OPTIONS_INVALID');
  const plan = validateInstall(config), files = voiceServiceFiles(root), serviceEpoch = crypto.randomUUID(), startedAt = new Date().toISOString();
  noLinks(files.lock); noLinks(files.state); fs.mkdirSync(files.directory, { recursive: true });
  try { fs.writeFileSync(files.lock, JSON.stringify({ pid: process.pid, serviceEpoch }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') throw fault('VOICE_SERVICE_BUSY'); throw error; }
  let child, ended = false, stopping = false, stopTask, closeResult, settled, rejectDone;
  const lifecycle = new AbortController(), done = new Promise((resolve, reject) => { settled = resolve; rejectDone = reject; });
  done.catch(() => {});
  const writeState = (status, voiceProfile = null) => {
    const temporary = files.state + '.' + serviceEpoch + '.tmp';
    noLinks(files.state);
    try {
      fs.writeFileSync(temporary, JSON.stringify({ status, startedAt, serviceEpoch, supervisorPid: process.pid, serverPid: child?.pid ?? null, baseUrl: config.baseUrl, configPath: files.configPath, voiceProfile }), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, files.state);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    onState({ status });
  };
  const release = () => {
    noLinks(files.lock);
    if (JSON.parse(fs.readFileSync(files.lock, 'utf8')).serviceEpoch !== serviceEpoch) throw fault('VOICE_SERVICE_CLEANUP_UNCONFIRMED');
    fs.unlinkSync(files.lock);
  };
  const exitCleanup = () => {
    if (ended || !child?.pid) return;
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    else child.kill();
  };
  const finish = (code, childSignal) => {
    if (ended) return;
    ended = true; lifecycle.abort(); process.removeListener('exit', exitCleanup);
    signal?.removeEventListener('abort', abort);
    try { writeState('stopped'); release(); closeResult = { code: code ?? (stopping ? 0 : 1), signal: childSignal ?? null }; settled(closeResult); }
    catch { rejectDone(fault('VOICE_SERVICE_CLEANUP_UNCONFIRMED')); }
  };
  const stop = () => stopTask ??= (async () => {
    stopping = true; lifecycle.abort();
    if (!ended && child) killTree(child);
    let timer;
    try { return await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(fault('VOICE_SERVICE_CLEANUP_UNCONFIRMED')), stopTimeoutMs); })]); }
    finally { clearTimeout(timer); }
  })();
  const abort = () => { void stop().catch(() => {}); };
  try {
    await checkPort(plan.port); active(signal);
    child = spawnImpl(plan.python, ['-u', '-c', bootstrap(serviceEpoch), plan.api, '-a', '127.0.0.1', '-p', String(plan.port), '-c', plan.yaml], {
      cwd: config.paths.root, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', CUDAGraph: '0', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HOME: path.join(files.directory, 'cache/huggingface') },
    });
    child.once('error', () => {}); // close always follows spawn error; no upstream output is logged.
    child.once('close', finish); process.on('exit', exitCleanup);
    signal?.addEventListener('abort', abort, { once: true });
    writeState('starting'); active(signal);
    const deadline = Date.now() + timeoutMs;
    let ready = false;
    const ownsLiveServer = async () => {
      if (ended || stopping || child.exitCode !== null || child.signalCode !== null) return false;
      const current = await probe(config, { signal: lifecycle.signal });
      return !ended && !stopping && current.available && current.compatible && current.serviceEpoch === serviceEpoch;
    };
    while (!ended && !stopping && Date.now() < deadline) {
      if (await ownsLiveServer()) { ready = true; break; }
      await delay(pollMs, undefined, { signal: lifecycle.signal });
    }
    active(signal);
    if (!ready || ended || stopping) throw fault(ended ? 'VOICE_SERVICE_START_FAILED' : 'VOICE_SERVICE_START_TIMEOUT');
    await resetService(config, { serviceEpoch, signal: lifecycle.signal, ownsLiveServer });
    const selected = applySelectedAtStart
      ? await createProfiles({ root, configPath: files.configPath }).applySelected({ signal: lifecycle.signal })
      : null;
    if (selected && !selected.applied) throw fault('VOICE_SERVICE_PROFILE_NOT_APPLIED');
    active(signal); active(lifecycle.signal);
    writeState('ready', selected && { selectedId: selected.selectedId, status: selected.status, verification: selected.verification });
    return { serviceEpoch, baseUrl: config.baseUrl, stop, done, get alive() { return !ended && !stopping; } };
  } catch (error) {
    if (child) await stop();
    else { ended = true; release(); settled({ code: 1, signal: null }); }
    active(signal);
    if (error?.code === 'VOICE_SERVICE_ABORTED') throw fault('VOICE_SERVICE_START_FAILED');
    if (/^VOICE_[A-Z0-9_]+$/.test(error?.code ?? '')) throw error;
    throw fault('VOICE_SERVICE_START_FAILED');
  }
}
