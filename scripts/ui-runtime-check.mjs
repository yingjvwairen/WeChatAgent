import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readSpeechProviderView } from './speech-provider-settings.mjs';

const execute = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, '..');
const fault = code => Object.assign(new Error(code), { code });
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const codexPath = value => /(?:^|[\\/])(?:\.codex|codex-runtimes|codex-primary-runtime)(?:[\\/]|$)/i.test(value);
function existingFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw fault('UI_RUNTIME_FILE_MISSING');
  return fs.realpathSync(file);
}
async function invoke(file, args) {
  const { stdout } = await execute(file, args, { windowsHide: true, shell: false, timeout: 30000, maxBuffer: 512 * 1024, cwd: projectRoot });
  return stdout.trim();
}

/** Standalone self-tests. UIA is optional for existing visual deployments;
 * callers explicitly checking UIA readiness can require its two helpers. */
export async function checkNativeUiComponents({ root = projectRoot, invokeImpl = invoke, requireUia = false } = {}) {
  const checks = [];
  for (const [name, file] of [['qt-actions','state/ui-host/WechatQtActions.exe'],['ui-host','state/ui-host/WechatUiHost.exe'],['visual','state/ui-host/WechatVisualProbe.exe'],['frame-capture','state/ui-host/WechatFrameCapture.exe'],['account-probe','state/ui-host/WechatAccountProbe.exe'],['draft-probe','state/ui-host/WechatDraftProbe.exe'],['timed-voice-probe','state/ui-host/WechatVoicePreview.exe'],['audio','state/audio-probe/AudioRouteProbe.exe']]) {
    try {
      const detail = JSON.parse(await invokeImpl(existingFile(path.join(root, file)), ['--self-test']));
      if (detail.ok !== true) throw fault('UI_RUNTIME_NATIVE_CHECK_FAILED');
      if (['qt-actions','draft-probe'].includes(name) && (detail.selfTest !== true || detail.uiAccessed !== false || detail.inputSent !== false || detail.clipboardAccessed !== false)) throw fault('UI_RUNTIME_NATIVE_CHECK_FAILED');
      if (name === 'timed-voice-probe' && (detail.selfTest !== true || detail.uiAccessed !== false || detail.devicesAccessed !== false || detail.audioStarted !== false || detail.inputSent !== false)) throw fault('UI_RUNTIME_NATIVE_CHECK_FAILED');
      checks.push({ name, ok: true, detail });
    } catch (error) {
      checks.push({ name, ok: false, code: /^UI_[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'UI_RUNTIME_CHECK_FAILED' });
    }
  }
  for (const [name, file] of [['accessibility-gate','WechatAccessibilityGate.exe'],['background-controls','WechatBackgroundControls.exe']]) {
    try {
      const detail = JSON.parse(await invokeImpl(existingFile(path.join(root, 'state/ui-host', file)), ['--self-test']));
      if (detail.ok !== true || detail.inputSent !== false ||
          name === 'accessibility-gate' && (detail.memoryWriteAttempted !== false || !Number.isInteger(detail.tests) || detail.tests < 1) ||
          name === 'background-controls' && (detail.uiAccessed !== false || detail.readOnly !== true || !Number.isInteger(detail.checks) || detail.checks < 1)) throw fault('UI_RUNTIME_NATIVE_CHECK_FAILED');
      checks.push({name, ok:true, required:requireUia, detail});
    } catch (error) {
      checks.push({name, ok:false, required:requireUia, code:/^UI_[A-Z0-9_]+$/.test(error.code??'')?error.code:'UI_RUNTIME_CHECK_FAILED'});
    }
  }
  return { ok: checks.every(check => check.required === false || check.ok), uiaReady: checks.filter(check => ['accessibility-gate','background-controls'].includes(check.name)).every(check => check.ok), checks };
}

/** Read-only checks: no live screenshots, UI input, audio playback or server startup. */
export async function checkUiRuntime(configFile) {
  const configPath = existingFile(configFile);
  if (fs.statSync(configPath).size > 16384) throw fault('UI_RUNTIME_CONFIG_INVALID');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (config.schemaVersion !== 1 || typeof config.dshRoot !== 'string' || !path.isAbsolute(config.dshRoot)) throw fault('UI_RUNTIME_CONFIG_INVALID');
  const expected = path.join(config.dshRoot, 'resources/runtime/primary-runtime/dependencies');
  const node = existingFile(config.node), python = existingFile(config.pythonBase);
  if (!samePath(node, path.join(expected, 'node/bin/node.exe')) || !samePath(python, path.join(expected, 'python/python.exe')) ||
      !samePath(process.execPath, node) || [node, python].some(codexPath)) throw fault('UI_RUNTIME_DSH_BINDING_MISMATCH');
  const results = [];
  const run = async (name, action) => {
    try { const detail = await action(); results.push({ name, ok: true, detail }); }
    catch (error) { results.push({ name, ok: false, code: /^UI_[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'UI_RUNTIME_CHECK_FAILED' }); }
  };
  await run('environment', async () => {
    if (Object.keys(process.env).some(name => /^CODEX/i.test(name)) || (process.env.PATH ?? '').split(path.delimiter).some(codexPath) ||
        process.env.PYTHONHOME || process.env.PYTHONPATH || process.env.NODE_OPTIONS || process.env.NODE_PATH) throw fault('UI_RUNTIME_DEVELOPMENT_ENV_PRESENT');
    return { nodeVersion: process.version, nodeSource: 'dsh', codexEnvironmentPresent: false };
  });
  const cloudTts = readSpeechProviderView({root:projectRoot}).tts.mode === 'cloud';
  for (const [name, relative] of [['ocr-python','state/ocr/venv/Scripts/python.exe'],['voice-python','state/dania-voice/venv/Scripts/python.exe'],['reader-python','state/reader/venv/Scripts/python.exe']]) {
    if (name === 'voice-python' && cloudTts) continue;
    await run(name, async () => {
      const executable = existingFile(path.join(projectRoot, relative));
      const imports = name === 'ocr-python' ? 'rapidocr,onnxruntime,PIL' : name === 'reader-python' ? 'sqlcipher3,cryptography,zstandard,Crypto,PIL,imageio_ffmpeg' : 'torch,transformers,soundfile';
      const detail = JSON.parse(await invoke(executable, ['-c', `import sys,json,${imports}; print(json.dumps({"version":list(sys.version_info[:3]),"basePrefix":sys.base_prefix,"prefix":sys.prefix}))`]));
      if (!samePath(detail.basePrefix, path.dirname(python)) || codexPath(detail.basePrefix) ||
          !samePath(detail.prefix, path.dirname(path.dirname(executable))) || samePath(detail.basePrefix, detail.prefix) ||
          !Array.isArray(detail.version) || detail.version[0] !== 3 || detail.version[1] !== 12) throw fault('UI_RUNTIME_PYTHON_BASE_MISMATCH');
      if (name === 'ocr-python') {
        const runtime = JSON.parse(await invoke(executable, [path.join(projectRoot, 'scripts/local-ocr.py')]));
        if (runtime.ok !== true || runtime.readOnly !== true || runtime.inputSent !== false) throw fault('UI_RUNTIME_OCR_CHECK_FAILED');
      }
      return { version: detail.version, baseSource: 'dsh', isolated: true, ...(name === 'ocr-python' ? { pinnedOcrRuntimeVerified: true } : {}) };
    });
  }
  results.push(...(await checkNativeUiComponents()).checks);
  await run('contact-identity-code', async () => {
    const { contactIdentity } = await import('./contact-identity.mjs');
    existingFile(path.join(projectRoot, 'scripts/contact-identity.py'));
    if (typeof contactIdentity !== 'function') throw fault('UI_RUNTIME_CONTACT_MODULE_INVALID');
    return { modulesLoaded: true, databaseRead: false, keyComponentLoaded: false, networkStarted: false };
  });
  await run('draft-probe-code', async () => {
    const { inspectDraftBinding, validateDraftRequest, verifyDraft } = await import('./draft-probe.mjs');
    if (![inspectDraftBinding, validateDraftRequest, verifyDraft].every(value => typeof value === 'function')) throw fault('UI_RUNTIME_DRAFT_MODULE_INVALID');
    return { modulesLoaded: true, uiAccessed: false, inputSent: false, clipboardAccessed: false, liveSessionStarted: false };
  });
  await run('timed-voice-code', async () => {
    const { validateTimedVoiceRequest, runTimedVoicePreview } = await import('./timed-voice-preview.mjs');
    if (![validateTimedVoiceRequest, runTimedVoicePreview].every(value => typeof value === 'function')) throw fault('UI_RUNTIME_VOICE_MODULE_INVALID');
    return { modulesLoaded: true, uiAccessed: false, audioStarted: false, inputSent: false, liveSessionStarted: false };
  });
  await run('text-queue', async () => {
    const { runUiDemo } = await import('./ui-preview.mjs');
    return runUiDemo();
  });
  await run('voice-code', async () => {
    const { inspectPlaybackWav } = await import('./cable-player.mjs');
    const { resolveDaniaConfig } = await import('./voice-synthesis.mjs');
    if (cloudTts) return {provider:'cloud', configured:true, audioStarted:false, networkStarted:false};
    const voiceConfig = resolveDaniaConfig({ configPath: path.join(projectRoot, 'state/dania-voice/config.json') });
    if (!samePath(existingFile(voiceConfig.paths.pythonPath), path.join(projectRoot, 'state/dania-voice/venv/Scripts/python.exe'))) throw fault('UI_RUNTIME_VOICE_CONFIG_MISMATCH');
    for (const key of ['refAudio','gptWeights','sovitsWeights']) existingFile(voiceConfig.paths[key]);
    if (typeof inspectPlaybackWav !== 'function') throw fault('UI_RUNTIME_VOICE_MODULE_INVALID');
    return { modulesLoaded: true, modelAssetsPresent: true, audioStarted: false, modelServerStarted: false };
  });
  const requiredReady = results.every(result => result.required === false || result.ok);
  return { mode: 'dsh-independent-development-check', ok: requiredReady,
    projectRoot, checks: results, codexRequired: requiredReady ? false : null, botReady: false, liveUiTested: false, inputSent: false, audioStarted: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  (async () => {
    if (args.length !== 2 || args[0] !== '--config') throw fault('UI_RUNTIME_ARGUMENTS_INVALID');
    const result = await checkUiRuntime(path.resolve(args[1]));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  })().catch(error => { console.error(/^UI_[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'UI_RUNTIME_CHECK_FAILED'); process.exitCode = 1; });
}
