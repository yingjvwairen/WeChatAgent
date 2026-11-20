import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkLocalReader } from './reader-local-setup.mjs';
import { activeReaderAccount, readerAccountId } from './reader-account-state.mjs';
import { validateQtConfig, clearQuoteDraftMarkers } from './qt-visual-driver.mjs';
import { validateVoiceRecordingLayout } from './voice-recording-layout.mjs';
import { resolveDaniaConfig } from './voice-synthesis.mjs';
import { readSpeechProviderView,voiceProfileCatalogFile } from './speech-provider-settings.mjs';
import { analyzeSecondaryPcAudio } from './secondary-pc-audio-preflight.mjs';
import { inspectPreparationControl, recoverPreparationControl } from './ui-reply-outbox.mjs';
import { inspectVoiceOperatorRecovery, recoverVoiceOperatorRecovery } from './voice-operator-recovery.mjs';
import { windowsPowerShellExecutable, windowsPowerShellEnvironment } from './console-process.mjs';

const execute = promisify(execFile);
const fault = code => Object.assign(new Error(code), { code });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\0\r\n]/.test(value);
const pair = value => object(value) && Object.keys(value).length === 2 && bounded(value.renderId) && bounded(value.captureId) && value.renderId !== value.captureId;
/** Read-only local process evidence. A failed or incomplete enumeration is not
 * evidence that native input/audio helpers have stopped. No process is killed. */
export async function nativeInputHelpersStopped({ executeImpl = execute, platform = process.platform } = {}) {
  if (platform !== 'win32') return false;
  const source = "$ErrorActionPreference='Stop'; $items=@(Get-CimInstance Win32_Process -Filter \"Name='WechatVoicePreview.exe' OR Name='WechatQtActions.exe' OR Name='WechatUiHost.exe' OR Name='WechatDraftProbe.exe' OR Name='WechatWindowMessageProbe.exe' OR Name='AudioRouteProbe.exe'\"); [ordered]@{version=1;complete=$true;count=$items.Count} | ConvertTo-Json -Compress";
  try {
    const result = await executeImpl(windowsPowerShellExecutable(), ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')], { windowsHide:true,shell:false,timeout:10000,maxBuffer:4096,env:windowsPowerShellEnvironment() });
    const value = JSON.parse(result.stdout.replace(/^\uFEFF/,''));
    return object(value) && Object.keys(value).length === 3 && value.version === 1 && value.complete === true && value.count === 0;
  } catch { return false; }
}
function noLinks(file) {
  for (let at = path.resolve(file);; at = path.dirname(at)) {
    if (fs.lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('UI_RUNTIME_LINK_REFUSED');
    if (path.dirname(at) === at) return path.resolve(file);
  }
}
function localFile(root, value) {
  if (!bounded(value) || !path.isAbsolute(value) || /^[\\/]{2}/.test(value)) throw fault('UI_RUNTIME_CONFIG_PATH_INVALID');
  const relative = path.relative(root, value);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw fault('UI_RUNTIME_CONFIG_PATH_INVALID');
  return noLinks(value);
}
function read(file, max = 65536) {
  noLinks(file); const info = fs.statSync(file, { throwIfNoEntry: false });
  if (!info) return null;
  if (!info.isFile() || info.size > max) throw fault('UI_RUNTIME_CONFIG_INVALID');
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw fault('UI_RUNTIME_CONFIG_INVALID'); }
}
function present(file) {
  if (!bounded(file) || !path.isAbsolute(file) || /^[\\/]{2}/.test(file)) throw fault('UI_RUNTIME_CONFIG_PATH_INVALID');
  noLinks(file); const info = fs.statSync(file, { throwIfNoEntry: false }); return !!info?.isFile() && info.size > 0;
}
function atomic(file, value) {
  noLinks(file); fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + crypto.randomUUID() + '.tmp'; let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    noLinks(file); fs.renameSync(temp, file);
  } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function modelConfiguration(root) {
  const provider = readSpeechProviderView({root}).tts;
  if (provider.mode === 'cloud') return { configured:true, fingerprint:hash(JSON.stringify(provider)) };
  const configPath = path.join(root, 'state/dania-voice/config.json');
  const base = read(configPath), profiles = read(voiceProfileCatalogFile(root,path.dirname(configPath)), 1024 * 1024);
  if (!base) return { configured: false, fingerprint: '' };
  let overrides = {};
  if (profiles) {
    if (profiles.schema !== 1 || !Array.isArray(profiles.profiles) || profiles.profiles.length > 64) throw fault('UI_RUNTIME_VOICE_CONFIG_INVALID');
    const selected = profiles.profiles.filter(row => row.id === profiles.selectedId);
    if (selected.length !== 1 || !object(selected[0].config)) throw fault('UI_RUNTIME_VOICE_CONFIG_INVALID');
    overrides = selected[0].config;
  }
  const config = resolveDaniaConfig({ configPath, overrides });
  const configured = ['gptWeights','sovitsWeights','refAudio'].every(key => present(config.paths[key]));
  return { configured, fingerprint: hash(JSON.stringify([base, profiles])) };
}
function voiceCalibration(config) {
  const v = config.voice, layout = config.layout;
  if (!object(v) || !object(layout)) return false;
  if (v.recordingUi?.adaptive && v.recordingUi.adaptive.executableVersion !== config.executableVersion) return false;
  // Match the execution driver's fixed/adaptive schema. This checks saved
  // geometry only; adaptive buttons still need fresh native identification.
  try {
    validateVoiceRecordingLayout({ recordingUi:v.recordingUi,
      clientRect:{ left:0,top:0,right:layout.width,bottom:layout.height },
      recordStartRect:v.recordStartRect,mouseParkRect:v.mouseParkRect,
      editorRect:layout.editor,dpi:layout.dpi,allowSameFocus:true });
    return true;
  }
  catch { return false; }
}
const explanations = {
  UI_RUNTIME_CONFIG_INVALID: '界面发送配置格式无效，请先检查本机配置文件。',
  UI_RUNTIME_CONFIG_PATH_INVALID: '界面发送配置必须保存在当前项目目录内。',
  UI_RUNTIME_READER_REQUIRED: '请先连接微信并激活当前账号的读取配置。',
  UI_RUNTIME_CALIBRATION_REQUIRED: '请先完成本机微信窗口标定。',
  UI_RUNTIME_ACCOUNT_MISMATCH: '窗口标定与当前读取账号或微信版本不一致，请重新标定。',
  UI_RUNTIME_HELPERS_REQUIRED: '请先在工具页准备本机界面组件。',
  UI_RUNTIME_VOICE_CALIBRATION_REQUIRED: '语音回复还需要本机录音入口和可识别的录音按钮布局。',
  UI_RUNTIME_VOICE_CONFIG_REQUIRED: '请先配置所选语音合成服务。使用本地合成时需要 GPT-SoVITS 权重和参考音频。',
  UI_RUNTIME_AUDIO_PAIR_REQUIRED: '请先选择本机 VB-CABLE 语音设备。',
  UI_RUNTIME_VOICE_HELPERS_REQUIRED: '请先准备本机语音及音频检测组件。',
  UI_RUNTIME_REPLY_CONFIG_INVALID: '回复方式配置需要检查。',
  UI_RUNTIME_LINK_REFUSED: '本机配置路径不能经过链接或目录联接。',
  UI_RUNTIME_STOP_SERVICES: '请先正常停止机器人及语音操作，再开启自动回复。',
  UI_RUNTIME_RECOVERY_REQUIRED: '读取恢复尚未完成，请先恢复读取记录。',
  UI_RUNTIME_PREPARATION_RECOVERY_REQUIRED: '微信窗口或身份核验中断，发送已暂停。请检查微信状态后，在此恢复待发回复的核验。',
  UI_RUNTIME_PREPARATION_STATE_INVALID: '发送暂停记录需要检查，不能自动清除。',
};

/** A disk-only readiness view. A saved calibration is not proof of the current
 * foreground window, account, draft, audio stream, or selected recipient. */
export function createUiRuntimeControls({ root = path.resolve(import.meta.dirname, '..'), check = checkLocalReader, executeImpl = execute, helpersStopped = () => nativeInputHelpersStopped({executeImpl}) } = {}) {
  root = path.resolve(root);
  function inspect(override, ownLease) {
    const blockers = [], add = code => { if (!blockers.some(row => row.code === code)) blockers.push({ code, message: explanations[code] ?? '本机配置需要检查。' }); };
    let file = path.join(root, 'state/ui-bridge/config.json'), settings, configured = false, binding, host, accountMatches = false, helpersReady = false;
    const mode = 'automatic'; let model = { configured: false, fingerprint: '' }, hostRaw = null, project;
    try {
      project = read(path.join(root, 'config/wechatagent.json'), 1024 * 1024);
      if (project?.ui?.bridgeConfig !== undefined) file = localFile(root, project.ui.bridgeConfig);
      const stored = read(file); configured = stored !== null;
      settings = override ?? stored ?? { version: 1, driver: 'qt-visual', hostConfig: path.join(root, 'state/ui-runtime/qt-visual.json'), enableInput: false, allowSubmit: false };
      if (!object(settings) || settings.version !== 1 || settings.driver !== 'qt-visual' || typeof settings.enableInput !== 'boolean' || typeof settings.allowSubmit !== 'boolean' || settings.allowSubmit && !settings.enableInput ||
          (settings.allowClipboardReplacement !== undefined && typeof settings.allowClipboardReplacement !== 'boolean') ||
          ['reader','token','accountWxid','accountDirectory','selectionFile','targets','onebotUrl'].some(k => Object.hasOwn(settings, k)) || settings.voice !== undefined && !pair(settings.voice)) throw fault('UI_RUNTIME_CONFIG_INVALID');
      localFile(root, settings.hostConfig);
    } catch (error) { add(explanations[error.code] ? error.code : 'UI_RUNTIME_CONFIG_INVALID'); }
    try {
      binding = check({ root });
      const active = activeReaderAccount(root), reader = read(path.join(root, 'state/weflow/WeFlow-config.json'));
      if (project?.runtime?.sender !== 'wechat-ui' || !binding.cached || active.id !== binding.account.accountRef || readerAccountId(root, reader) !== binding.account.accountRef) throw 0;
    } catch { binding = null; add('UI_RUNTIME_READER_REQUIRED'); }
    try {
      hostRaw = settings?.hostConfig ? read(localFile(root, settings.hostConfig)) : null;
      host = validateQtConfig(hostRaw);
      accountMatches = !!binding && host.accountRef === binding.account.accountRef && host.account === binding.account.myWxid.trim().replace(/_[A-Za-z0-9]{4}$/u, '') &&
        path.resolve(host.executable).toLowerCase() === path.resolve(binding.request.wechatExecutable).toLowerCase() && host.executableSha256 === binding.request.wechatExecutableSha256;
      if (!accountMatches) add('UI_RUNTIME_ACCOUNT_MISMATCH');
      helpersReady = ['state/ui-host/WechatQtActions.exe','state/ui-host/WechatAccountProbe.exe', host.ocrBackend === 'rapidocr' ? 'state/ocr/venv/Scripts/python.exe' : 'state/ui-host/WechatVisualProbe.exe'].every(name => present(path.join(root, name)));
      if (!helpersReady) add('UI_RUNTIME_HELPERS_REQUIRED');
    } catch { add('UI_RUNTIME_CALIBRATION_REQUIRED'); }
    try { model = modelConfiguration(root); } catch { model = { configured: false, fingerprint: 'invalid' }; }
    let voiceHelpersReady = false;
    try { voiceHelpersReady = ['state/ui-host/WechatVoicePreview.exe','state/audio-probe/AudioRouteProbe.exe'].every(name => present(path.join(root, name))); } catch {}
    const voiceConfigured = !!host && voiceCalibration(host), audioConfigured = pair(settings?.voice);
    if (settings?.voice) {
      if (!voiceConfigured) add('UI_RUNTIME_VOICE_CALIBRATION_REQUIRED');
      if (!model.configured) add('UI_RUNTIME_VOICE_CONFIG_REQUIRED');
      if (!audioConfigured) add('UI_RUNTIME_AUDIO_PAIR_REQUIRED');
      if (!voiceHelpersReady) add('UI_RUNTIME_VOICE_HELPERS_REQUIRED');
    }
    let serviceRunning = false;
    try {
      const managed = read(path.join(root, 'state/runtime.json')) ?? {};
      serviceRunning = !!managed.adapter || !!managed.reader || ['state/ui-service.lock','state/reader-service/service.lock','state/native-voice-outbox/worker.lock','state/native-voice-attempts/active.json','state/voice-preview/timed/active.json','state/ui-voice-submit-previews/active.json','state/voice-operator-recovery/lock','state/voice-operator-recovery/transaction.json'].some(relative => {
        const target = noLinks(path.join(root, relative));
        if (!fs.existsSync(target)) return false;
        if (relative === 'state/ui-service.lock' && ownLease && read(target)?.runtimeControlsLease === ownLease) return false;
        return true;
      });
    } catch { serviceRunning = true; }
    if (serviceRunning) add('UI_RUNTIME_STOP_SERVICES');
    if (fs.existsSync(path.join(root, 'state/reader-service/recovery-transaction.json'))) add('UI_RUNTIME_RECOVERY_REQUIRED');
    let preparationDirectory, preparation = { required:false, canRecover:false, revision:null, reason:null };
    if (binding && accountMatches && host) {
      try {
        preparationDirectory = localFile(root, path.join(root, 'state/ui-text-deliveries', hash(host.account), 'routes'));
        const saved = inspectPreparationControl(preparationDirectory);
        preparation = { required:saved.recoveryRequired, canRecover:saved.recoveryRequired && !serviceRunning,
          revision:saved.revision, reason:saved.recoveryRequired ? saved.reason : null };
        if (saved.recoveryRequired) add('UI_RUNTIME_PREPARATION_RECOVERY_REQUIRED');
      } catch { preparationDirectory = undefined; add('UI_RUNTIME_PREPARATION_STATE_INVALID'); }
    }
    const revision = hash(JSON.stringify([file,settings ?? null,hostRaw,project?.runtime?.sender,binding?.account.accountRef ?? null,mode,model,helpersReady,voiceHelpersReady,serviceRunning,preparation,blockers.map(row=>row.code)]));
    const view = { revision, configured, enabled: settings?.enableInput === true && settings?.allowSubmit === true, canEnable: blockers.length === 0, blockers,
      calibration: { configured: !!host, accountMatches, helpersReady, voiceConfigured },
      voice: { configured: audioConfigured, modelConfigured: model.configured, helpersReady: voiceHelpersReady, available:audioConfigured&&model.configured&&voiceHelpersReady&&voiceConfigured, autoStart:true }, replyMode: mode,
      preparationRecovery: preparation,
      serviceRunning, liveUiVerified: false, streamIsolationVerified: false, servicesStarted: false, inputSent: false };
    const recoveryContext = binding && accountMatches && host ? { accountScopeHash:binding.account.accountRef,
      fingerprint:hash(JSON.stringify([file,settings,hostRaw,project?.runtime?.sender,binding.account.accountRef])) } : undefined;
    return { view, settings, file, preparationDirectory, recoveryContext };
  }
  async function audioDevices() {
    const executable = localFile(root, path.join(root, 'state/audio-probe/AudioRouteProbe.exe'));
    if (!present(executable)) throw fault('UI_RUNTIME_AUDIO_PROBE_REQUIRED');
    let raw;
    try { raw = JSON.parse((await executeImpl(executable, ['--list'], { cwd: root, windowsHide: true, shell: false, timeout: 15000, maxBuffer: 256 * 1024 })).stdout.replace(/^\uFEFF/, '')); }
    catch { throw fault('UI_RUNTIME_AUDIO_ENUMERATION_FAILED'); }
    try { analyzeSecondaryPcAudio({ audioSnapshot: raw }); } catch { throw fault('UI_RUNTIME_AUDIO_METADATA_INVALID'); }
    if (new Set(raw.devices.map(d => d.id)).size !== raw.devices.length) throw fault('UI_RUNTIME_AUDIO_METADATA_INVALID');
    const devices = raw.devices.filter(d => d.adapter === 'VB-Audio Virtual Cable' && d.name === (d.flow === 'render' ? 'CABLE Input (VB-Audio Virtual Cable)' : 'CABLE Output (VB-Audio Virtual Cable)'));
    const renders = devices.filter(d => d.flow === 'render'), captures = devices.filter(d => d.flow === 'capture');
    return { devices: devices.map(({ id, name, flow }) => ({ id, name, flow })), pairs: renders.length === 1 && captures.length === 1 ? [{ renderId: renders[0].id, captureId: captures[0].id, name: 'VB-CABLE 虚拟语音线路' }] : [],
      audioStarted: false, captureOpened: false, settingsChanged: false, streamIsolationVerified: false };
  }
  async function save({ expectedRevision, enabled, voice } = {}) {
    if (!/^[a-f0-9]{64}$/.test(expectedRevision ?? '') || typeof enabled !== 'boolean' || voice !== undefined && voice !== null && !pair(voice)) throw fault('UI_RUNTIME_OPTIONS_INVALID');
    const lock = localFile(root, path.join(root, 'state/ui-bridge/controls.lock'));
    fs.mkdirSync(path.dirname(lock), { recursive: true }); let fd, serviceFd, lease;
    const serviceLock = localFile(root, path.join(root, 'state/ui-service.lock'));
    try { fd = fs.openSync(lock, 'wx', 0o600); } catch { throw fault('UI_RUNTIME_BUSY'); }
    try {
      const current = inspect();
      if (current.view.revision !== expectedRevision) throw fault('UI_RUNTIME_VERSION_CONFLICT');
      if (!current.settings || current.view.blockers.some(b => ['UI_RUNTIME_CONFIG_INVALID','UI_RUNTIME_CONFIG_PATH_INVALID','UI_RUNTIME_LINK_REFUSED'].includes(b.code))) throw fault('UI_RUNTIME_CONFIG_INVALID');
      const next = { ...current.settings, enableInput: enabled, allowSubmit: enabled };
      if (voice === null) delete next.voice; else if (voice !== undefined) next.voice = { ...voice };
      if (enabled) {
        if (current.view.serviceRunning) throw fault('UI_RUNTIME_STOP_SERVICES');
        lease = crypto.randomUUID();
        try { serviceFd = fs.openSync(serviceLock, 'wx', 0o600); fs.writeFileSync(serviceFd, JSON.stringify({ pid: process.pid, runtimeControlsLease: lease })); }
        catch { throw fault('UI_RUNTIME_STOP_SERVICES'); }
      }
      if (voice !== undefined && voice !== null || enabled && next.voice) {
        const listed = await audioDevices();
        if (!listed.pairs.some(p => p.renderId === next.voice?.renderId && p.captureId === next.voice?.captureId)) throw fault('UI_RUNTIME_AUDIO_PAIR_REQUIRED');
      }
      // Enumeration may take time. Recheck the full disk/account revision before
      // persisting permission, then evaluate the proposed state, not the old pair.
      if (inspect(undefined, lease).view.revision !== expectedRevision) throw fault('UI_RUNTIME_VERSION_CONFLICT');
      const proposed = inspect(next, lease);
      if (voice !== undefined && voice !== null) {
        const missing=proposed.view.blockers.find(row=>['UI_RUNTIME_VOICE_CALIBRATION_REQUIRED','UI_RUNTIME_VOICE_CONFIG_REQUIRED','UI_RUNTIME_VOICE_HELPERS_REQUIRED'].includes(row.code));
        if(missing)throw fault(missing.code);
      }
      if (enabled && !proposed.view.canEnable) throw fault(proposed.view.blockers[0].code);
      atomic(current.file, next);
      return { ...inspect(undefined, lease).view, saved: true, restartRequired: true, servicesStarted: false, inputSent: false };
    } finally {
      if (serviceFd !== undefined) { fs.closeSync(serviceFd); if (read(serviceLock)?.runtimeControlsLease === lease) fs.unlinkSync(serviceLock); }
      fs.closeSync(fd); fs.unlinkSync(lock);
    }
  }
  function recoverPreparation({ expectedRevision, acknowledgeReview } = {}) {
    if (!/^[a-f0-9]{64}$/.test(expectedRevision ?? '') || acknowledgeReview !== true) throw fault('UI_RUNTIME_OPTIONS_INVALID');
    const lock = localFile(root, path.join(root, 'state/ui-bridge/controls.lock'));
    const serviceLock = localFile(root, path.join(root, 'state/ui-service.lock'));
    fs.mkdirSync(path.dirname(lock), { recursive:true });
    let fd, serviceFd, lease;
    try { fd = fs.openSync(lock, 'wx', 0o600); } catch { throw fault('UI_RUNTIME_BUSY'); }
    try {
      const current = inspect();
      if (current.view.revision !== expectedRevision) throw fault('UI_RUNTIME_VERSION_CONFLICT');
      if (current.view.serviceRunning) throw fault('UI_RUNTIME_STOP_SERVICES');
      if (!current.preparationDirectory || !current.view.preparationRecovery.canRecover) throw fault('UI_RUNTIME_PREPARATION_RECOVERY_REQUIRED');
      lease = crypto.randomUUID();
      try { serviceFd = fs.openSync(serviceLock, 'wx', 0o600); fs.writeFileSync(serviceFd, JSON.stringify({ pid:process.pid, runtimeControlsLease:lease })); }
      catch { throw fault('UI_RUNTIME_STOP_SERVICES'); }
      const stoppedAndUnchanged = () => {
        const fresh = inspect(undefined, lease);
        return !fresh.view.serviceRunning && fresh.view.revision === expectedRevision && fresh.preparationDirectory === current.preparationDirectory;
      };
      if (!stoppedAndUnchanged()) throw fault('UI_RUNTIME_VERSION_CONFLICT');
      recoverPreparationControl(current.preparationDirectory, {
        expectedRevision:current.view.preparationRecovery.revision, assertStopped:stoppedAndUnchanged,
        onReviewed(saved) {
          if (!saved.reason.includes('QUOTE')) return;
          const route = read(path.join(current.preparationDirectory, saved.deliveryId + '.json'), 96 * 1024);
          if (route?.id !== saved.deliveryId || !bounded(route.target) || !current.recoveryContext?.accountScopeHash)
            throw fault('UI_RUNTIME_PREPARATION_RECOVERY_REQUIRED');
          clearQuoteDraftMarkers(root,current.recoveryContext.accountScopeHash,route.target);
        },
      });
      return { ...inspect(undefined, lease).view, recovered:true, servicesStarted:false, inputSent:false };
    } finally {
      if (serviceFd !== undefined) { fs.closeSync(serviceFd); if (read(serviceLock)?.runtimeControlsLease === lease) fs.unlinkSync(serviceLock); }
      fs.closeSync(fd); fs.unlinkSync(lock);
    }
  }
  function voiceServicesStopped(serviceLease) {
    try {
      const managed=read(path.join(root,'state/runtime.json'));
      if(managed?.adapter||managed?.reader)return false;
      for(const relative of ['state/ui-service.lock','state/reader-service/service.lock','state/native-voice-outbox/worker.lock','state/ui-voice-submit-previews/worker.lock']) {
        const file=noLinks(path.join(root,relative));if(!fs.existsSync(file))continue;
        if(relative==='state/ui-service.lock'&&serviceLease&&read(file)?.runtimeControlsLease===serviceLease)continue;
        return false;
      }
      return true;
    } catch { return false; }
  }
  function voiceRecoveryOptions() {
    const context=inspect().recoveryContext;
    if(!context)throw fault('UI_RUNTIME_READER_REQUIRED');
    const assertStopped=async({serviceLease,accountScopeHash}={})=>{
      const unchanged=()=>{const current=inspect(undefined,serviceLease).recoveryContext;return current?.accountScopeHash===context.accountScopeHash&&current.fingerprint===context.fingerprint&&voiceServicesStopped(serviceLease);};
      if(accountScopeHash!==context.accountScopeHash||!unchanged()||await helpersStopped()!==true)return false;
      return unchanged();
    };
    return {context,options:{root,accountScopeHash:context.accountScopeHash,assertStopped}};
  }
  async function inspectVoiceRecovery() {
    try {
      const {context,options}=voiceRecoveryOptions(),view=await inspectVoiceOperatorRecovery(options);
      return {...view,available:true,canRecover:view.required,revision:hash(JSON.stringify([context.fingerprint,view.revision]))};
    } catch(error) {
      return {available:false,required:null,canRecover:false,revision:null,reason:/^(?:VOICE_RECOVERY_|UI_RUNTIME_)[A-Z_]+$/.test(error?.code??'')?error.code:'VOICE_RECOVERY_UNAVAILABLE',servicesStarted:false,inputSent:false};
    }
  }
  async function recoverVoice(options) {
    if(!object(options)||Object.keys(options).length!==3||!/^[a-f0-9]{64}$/.test(options.expectedRevision??'')||options.acknowledgeRecordingEnded!==true||options.acknowledgeMessageOutcomeReviewed!==true)throw fault('UI_RUNTIME_OPTIONS_INVALID');
    const current=voiceRecoveryOptions(),view=await inspectVoiceOperatorRecovery(current.options);
    if(hash(JSON.stringify([current.context.fingerprint,view.revision]))!==options.expectedRevision)throw fault('UI_RUNTIME_VERSION_CONFLICT');
    // The recovery module owns both the controls and stopped-service leases.
    // The callback is trusted local evidence, never a field from the HTTP body.
    return recoverVoiceOperatorRecovery({...current.options,expectedRevision:view.revision,acknowledgeRecordingEnded:true,acknowledgeMessageOutcomeReviewed:true});
  }
  return { snapshot: () => inspect().view, audioDevices, save, recoverPreparation, inspectVoiceRecovery, recoverVoice };
}
