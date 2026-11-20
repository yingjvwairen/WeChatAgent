import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolveDaniaConfig} from './voice-synthesis.mjs';

const fail=code=>Object.assign(new Error(code),{code});
function localPath(value,kind) {
  if(typeof value!=='string'||!/^[A-Za-z]:[\\/]/.test(value)||/[\0\r\n]/.test(value))throw fail('SECONDARY_LOCAL_ABSOLUTE_PATH_REQUIRED');
  const resolved=path.resolve(value),stat=fs.statSync(resolved,{throwIfNoEntry:false});
  if(!stat||(kind==='directory'?!stat.isDirectory():!stat.isFile()))throw fail('SECONDARY_INSTALLED_FILE_MISSING');
  const canonical=fs.realpathSync(resolved);
  if(/^[\\/]{2}/.test(canonical))throw fail('SECONDARY_LOCAL_ABSOLUTE_PATH_REQUIRED');
  return canonical;
}
function independentPath(value) {
  if(/(?:^|[\\/])(?:\.codex|codex-runtimes|codex-primary-runtime)(?:[\\/]|$)/i.test(value))throw fail('SECONDARY_DEVELOPMENT_RUNTIME_REFUSED');
}
function noLinks(file) {
  for(let current=path.resolve(file);;current=path.dirname(current)){
    if(fs.lstatSync(current,{throwIfNoEntry:false})?.isSymbolicLink())throw fail('SECONDARY_CONFIG_LINK_REFUSED');
    if(path.dirname(current)===current)return;
  }
}
function writeNew(file,value) {
  noLinks(file);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const fd=fs.openSync(file,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}

/** Generates machine-local paths only; no processes, devices, or tests run. */
export function configureSecondary({root=path.resolve(import.meta.dirname,'..'),settings}={}) {
  if(process.platform!=='win32')throw fail('SECONDARY_WINDOWS_REQUIRED');
  noLinks(root);
  root=localPath(root,'directory');
  if(!settings||typeof settings!=='object'||Array.isArray(settings))throw fail('SECONDARY_SETTINGS_INVALID');
  const dshRoot=localPath(settings.dshRoot,'directory'),wechatExecutable=localPath(settings.wechatExecutable,'file');
  if(!/^weixin\.exe$/i.test(path.basename(wechatExecutable)))throw fail('SECONDARY_WECHAT_EXECUTABLE_INVALID');
  const deps=path.join(dshRoot,'resources/runtime/primary-runtime/dependencies');
  const node=localPath(path.join(deps,'node/bin/node.exe'),'file'),pythonBase=localPath(path.join(deps,'python/python.exe'),'file');
  const modelRoot=localPath(settings.gptSovitsRoot,'directory'),voicePython=localPath(settings.voicePython,'file');
  for(const file of [root,dshRoot,node,pythonBase,modelRoot,voicePython])independentPath(file);
  if(fs.realpathSync(process.execPath).toLowerCase()!==node.toLowerCase())throw fail('SECONDARY_DSH_RUNTIME_MISMATCH');
  const [nodeMajor,nodeMinor]=process.versions.node.split('.').map(Number);
  if(nodeMajor<22||(nodeMajor===22&&nodeMinor<13))throw fail('SECONDARY_NODE_VERSION_UNSUPPORTED');
  if(!/^python(?:w)?\.exe$/i.test(path.basename(voicePython)))throw fail('SECONDARY_VOICE_PYTHON_INVALID');
  // Match dania-start's required local files without importing Python or
  // downloading assets. Presence is not a runtime/model compatibility check.
  for(const relative of ['api_v2.py','GPT_SoVITS/configs/tts_infer.yaml','GPT_SoVITS/text/G2PWModel/g2pw.onnx','GPT_SoVITS/pretrained_models/fast_langdetect/lid.176.bin']){
    const file=localPath(path.join(modelRoot,relative),'file'),inside=path.relative(modelRoot,file);
    if(inside==='..'||inside.startsWith('..'+path.sep)||path.isAbsolute(inside))throw fail('SECONDARY_VOICE_FILE_OUTSIDE_MODEL_ROOT');
  }
  const files={};
  for(const key of ['gptWeights','sovitsWeights','refAudio']){
    if(typeof settings[key]!=='string')throw fail('SECONDARY_VOICE_FILE_REQUIRED');
    files[key]=localPath(path.resolve(modelRoot,settings[key]),'file');
    const relative=path.relative(modelRoot,files[key]);
    if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw fail('SECONDARY_VOICE_FILE_OUTSIDE_MODEL_ROOT');
  }
  if(path.extname(files.gptWeights).toLowerCase()!=='.ckpt'||path.extname(files.sovitsWeights).toLowerCase()!=='.pth')throw fail('SECONDARY_WEIGHT_EXTENSION_INVALID');
  if(typeof settings.promptText!=='string'||!settings.promptText.trim())throw fail('SECONDARY_REFERENCE_TEXT_REQUIRED');
  const installDir=path.join(root,'state/dania-voice');
  const proposed={installDir,root:modelRoot,pythonPath:voicePython,baseUrl:'http://127.0.0.1:9880',...files,
    promptText:settings.promptText,promptLang:settings.promptLang??'zh',textLang:settings.textLang??'zh',modelId:'secondary-default'};
  const outputs=[['state/ui-runtime.json',{schemaVersion:1,dshRoot,node,pythonBase,configuredAt:new Date().toISOString()}],
    ['state/dania-voice/config.json',proposed],['state/secondary-deployment.json',{schemaVersion:1,role:'streaming-secondary',
      machineBinding:crypto.createHash('sha256').update(os.hostname()+'\0'+os.userInfo().username+'\0'+root).digest('hex'),
      wechatExecutable,dshRoot,modelRoot,consoleHost:'127.0.0.1',consolePort:3210,
      autoStart:false,automaticReplies:false,accountSetupRequired:true,audioRouteSetupRequired:true,desktopCalibrationRequired:true,
      foregroundSenderProductionReady:false}]];
  // A copied production config can contain old account lists and machine paths
  // even when state is absent. The secondary-computer settings file is allowed.
  for(const relative of ['config/wechatagent.json','config/extensions.json','config/distribution.json']){
    const file=path.join(root,relative);noLinks(file);if(fs.existsSync(file))throw fail('SECONDARY_FRESH_PROJECT_REQUIRED');
  }
  // Protect against two concurrent bootstrap attempts, without replacing files.
  const state=path.join(root,'state');noLinks(state);fs.mkdirSync(state,{recursive:true,mode:0o700});
  const lock=path.join(state,'secondary-setup.lock');noLinks(lock);const fd=fs.openSync(lock,'wx',0o600);
  try{
    // This is a first-install entry: all old state is forbidden, including
    // future state directories not known to this version of the launcher.
    if(fs.readdirSync(state).some(name=>name!=='secondary-setup.lock'))throw fail('SECONDARY_FRESH_PROJECT_REQUIRED');
    // With a fresh state directory this cannot load another DSH installation.
    resolveDaniaConfig({dshHome:path.join(root,'state/secondary-dsh'),overrides:proposed});
    for(const [relative,value]of outputs)writeNew(path.join(root,relative),value);
  }
  finally{fs.closeSync(fd);fs.unlinkSync(lock);}
  return {configured:true,role:'streaming-secondary',automaticReplies:false,processesStarted:false,testsRun:false,
    next:['connect-secondary-account','choose-reply-targets','configure-isolated-audio','calibrate-secondary-desktop'],files:outputs.map(([relative])=>relative)};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--settings')throw fail('SECONDARY_SETTINGS_ARGUMENT_REQUIRED');
    const file=localPath(args[1],'file');if(fs.statSync(file).size>65536)throw fail('SECONDARY_SETTINGS_INVALID');
    const result=configureSecondary({settings:JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''))});
    console.log(JSON.stringify(result));
  }catch(error){console.error(/^SECONDARY_[A-Z_]+$/.test(error?.code??'')?error.code:'SECONDARY_SETUP_FAILED');process.exitCode=1;}
}
