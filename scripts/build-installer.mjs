import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { DSH_SDK_VERSION,DSH_INSTALL_URL } from '../public/console/dsh-install.mjs';
import { spawnSync } from 'node:child_process';
import {prepareInstallerRuntime} from './prepare-installer-runtime.mjs';
import { buildIcons, embedExecutableIcon } from './build-icons.mjs';
import { singleDirectoryTemplate } from './installer-directory-page.mjs';
import { projectRoot as root } from './project-config.mjs';
const version = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
const stage = path.join(root, 'state', 'installer-stage');
const appDir = path.join(stage, 'app');
const project = path.join(stage, 'project');
const vendor = path.join(stage, 'vendor');
const require = createRequire(path.join(root, 'package.json'));
const pluginPackage = JSON.parse(fs.readFileSync(path.join(root,'packages/dsh-social-bridge-plugin/package.json'),'utf8'));
const sdkPackage = JSON.parse(fs.readFileSync(path.join(root,'packages/dsh-social-bridge-plugin/node_modules/@deepseek-ai/dsh-llm/package.json'),'utf8'));
if (pluginPackage.dependencies['@deepseek-ai/dsh-llm'] !== DSH_SDK_VERSION || sdkPackage.version !== DSH_SDK_VERSION) throw new Error('Installed plugin SDK must match the declared DSH compatibility version.');
console.log('DSH desktop is external; only the bridge plugin and SDK '+DSH_SDK_VERSION+' are included.');
for (const dir of [appDir, project, vendor, path.join(stage, 'runtime')]) {
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(stage) + path.sep)) throw new Error('Invalid release staging directory');
  fs.rmSync(resolved, { recursive:true, force:true, maxRetries:5, retryDelay:100 });
}
for (const dir of [appDir, project, vendor, path.join(stage, 'runtime')]) fs.mkdirSync(dir, { recursive: true });
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const files = [];
function copyFile(source, target) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target); }
function copyTree(source, target, allow = () => true) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!allow(entry.name, entry.isDirectory()) || entry.isSymbolicLink()) continue;
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to, allow); else copyFile(from, to);
  }
}
function add(relative) { copyFile(path.join(root, relative), path.join(project, relative)); files.push(relative); }
function addTree(relative, allow) {
  copyTree(path.join(root, relative), path.join(project, relative), allow);
  for (const name of fs.readdirSync(path.join(project, relative), { recursive: true })) if (fs.statSync(path.join(project, relative, name)).isFile()) files.push((relative + '/' + name).replaceAll('\\', '/'));
}

for (const name of ['package.json','main.cjs','preload.cjs','shutdown.cjs','storage-location.cjs', 'desktop-policy.cjs','deployment.cjs','appearance.cjs', 'loading-preload.cjs','loading.html','loading.css','loading.js']) copyFile(path.join(root, 'apps/console-desktop', name), path.join(appDir, name));
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'wechatagent', productName: 'WeChatAgent', version, description: 'WeChatAgent desktop console', main: 'main.cjs', author: 'WeChatAgent contributors', license: 'SEE THIRD-PARTY-NOTICES.txt' }, null, 2));
await buildIcons(root, appDir, require('sharp'));
for (const name of ['LICENSE','LICENSES.md']) add(name);
for (const name of ['README.md','RELEASE_NOTES.md']) add(name);
addTree('docs', (name, directory) => directory || name.endsWith('.md'));
add('config/wechatagent.example.json');
for(const name of ['SESSION_RECOVERY.md','SEND_QUEUE_RECOVERY.md','MEDIA_RECOVERY.md','GROUP_REJOIN.md'])add('docs/'+name);
const presetNames = fs.readdirSync(path.join(root, 'roles')).filter(name => name.endsWith('.md') && name !== 'README.md');
for (const name of presetNames) add('roles/' + name);
addTree('public/console');
add('scripts/wechat_sticker_manager.py');
add('docs/STICKER_MANAGER.md');
add('docs/EXIT_SHUTDOWN.md');
add('docs/DATA_STORAGE.md');
add('docs/PORT_STARTUP_RECOVERY.md');
add('docs/REPLY_PROTOCOL.md');
add('docs/PROMPT_POLICY.md');
add('docs/REQUEST_REJECTION.md');
add('docs/ASSISTANT_MODE.md');
add('docs/PLUGIN_CATALOG.md');
add('docs/EXTERNAL_DSH.md');
add('docs/ACCOUNT_SWITCH.md');
add('docs/SESSION_GROUPS.md');
add('scripts/persona-categories.mjs');
add('docs/PERSONA_CATEGORIES.md');
add('scripts/memory-console.mjs');
add('scripts/memory-console-worker.mjs');
add('docs/MEMORY_VIEW.md');
add('scripts/fish-notebook-console.mjs');
add('docs/FISH_NOTEBOOK.md');
add('scripts/stop-legacy-services.ps1');
const scriptNames = ['wechat_files.py','project-config.mjs','extension-status.mjs','bundled-extensions.mjs','update-check.mjs','migrate-io-config.mjs','manage.ps1','console-server.mjs','console-process.mjs','console-powershell.ps1','console-native.ps1','reader-api.py','reader-requirements.txt','wechat_media.py','wechat_sticker.py','wechat_sticker_send.py','wechat_forwarded.py','resolve-wechat-image.py','list-friend-ids.mjs','manage-dsh-sessions.mjs','launch-dsh.ps1','check-runtime.ps1','setup.ps1'];
for (const name of [...scriptNames, 'wechat_mentions.py', 'wechat_group_bindings.py', 'dsh-configuration.mjs', 'process-recovery.mjs', 'process-recovery.ps1', 'check-runtime.py', 'wechat_meme_library.py', 'wechat_sticker_labels.py', 'wechat_image_normalize.py', 'wechat_sticker_collection.py', 'wechat_quote.py', 'wechat_extra_card.py', 'wechat_quote_source.py', 'reader-setup.mjs', 'reader_setup.py', 'reader-account-state.mjs']) add('scripts/' + name);
// UIA/OCR and local Reader sources.
for (const name of [
  'account-probe.mjs', 'bot-controls.mjs', 'speech-provider-settings.mjs', 'speech-provider-check.mjs', 'fixtures/speech-service-test.wav', 'plugin-config-ui.mjs', 'contact-identity.mjs', 'delivery-archive.mjs',
  'foreground-timing.mjs', 'local-ocr-client.mjs', 'prepare-reader-component.mjs',
  'qt-auto-layout.mjs', 'qt-layout-profiles.mjs', 'qt-visual-driver.mjs', 'qt-quote-ocr.mjs',
  'reader-local-setup.mjs', 'reader-target-service.mjs', 'reply-preferences.mjs',
  'runtime-interaction-policy.mjs', 'secondary-pc-audio-preflight.mjs', 'target-selection.mjs',
  'ui-reader-recovery.mjs', 'ui-reply-outbox.mjs', 'ui-runtime-controls.mjs', 'visual-probe.mjs',
  'voice-interruption-evidence.mjs', 'voice-operator-recovery.mjs', 'voice-profiles.mjs',
  'voice-recording-layout.mjs', 'voice-synthesis.mjs', 'wechat_av.py',
  'wechat_nested_media.py', 'wechat_voice_receipt.py', 'wechat_reference_media.py',
  'reader-target-service.py', 'reader-local-api.py', 'receipt_connections.py', 'contact-identity.py',
  'local-media-worker.py', 'local-asr-service.mjs', 'local-asr-worker.py', 'local_asr_runtime.py', 'prepare-local-media.mjs', 'local-ocr.py',
  'locate-wechat-layout.py', 'qt-auto-layout-image.py', 'qt_search_popup.py',
  'wechat-layout-templates.json', 'wechat-navigation-templates.json',

  'background-controls.mjs', 'uia-mode.mjs', 'uia-mode-runtime.mjs', 'uia-offscreen.mjs', 'uia-offscreen-mode.mjs',
  'build-accessibility-gate.ps1', 'build-background-controls.ps1',
  'build-uia-background-probe.ps1', 'build-uia-offscreen-probe.ps1', 'build-uia-offscreen-host.ps1', 'build-offscreen-focus.ps1',
  'managed-voice-service.mjs', 'cloud-speech.mjs', 'cloud-speech-wav.mjs', 'dania-server.mjs', 'dania-start.mjs',
  'reply-image-format.mjs', 'reply-media-catalog.mjs', 'ui-delivery-controls.mjs',
  'ui-image-outbox.mjs', 'ui-image-reader-receipts.mjs', 'ui-file-outbox.mjs', 'ui_file_receipts.py',
  'ui-onebot.mjs', 'ui-service.mjs', 'ui-text-outbox.mjs',
  'native-voice-outbox.mjs', 'native-voice-transport.mjs',
  'ui-reader-stream.mjs', 'ui-incoming-content.mjs', 'ui-reader-receipts.mjs', 'ui-host-client.mjs',
  'ui-reader-media-proxy.mjs', 'ui-voice-reader-receipts.mjs',
  'cable-player.mjs', 'timed-voice-preview.mjs', 'voice-warm-monitor.mjs', 'draft-probe.mjs',
]) add('scripts/' + name);
for (const name of ['onebot-identity.mjs','installed-ui-runtime.mjs','reader-local-prepare.mjs','prepare-ui-dependencies.mjs','prepare-ui-components.ps1','requirements-ocr.txt','prepare-local-ocr-model.mjs','ui-runtime.ps1','ui-runtime-args.mjs','ui-preview.mjs','frame-probe.mjs','voice-preview.mjs','qt-calibrate.mjs','secondary-setup.mjs','secondary-computer.ps1','build-qt-actions.ps1','build-account-probe.ps1','build-voice-probe.ps1','build-audio-probe.ps1','build-visual-probe.ps1','build-frame-capture.ps1','build-draft-probe.ps1','build-ui-host.ps1']) add('scripts/'+name);
addTree('scripts/native-audio', (name,directory)=>directory||name.endsWith('.cs'));
addTree('scripts/native-ui', (name,directory)=>directory||/\.(?:cs|json)$/.test(name));
for (const name of ['nt_decrypt.py','nt_common.py']) add('components/weflow-cli/scripts/' + name);
add('components/weflow-cli/LICENSE');
add('components/weflow-cli/resources/key/win32/x64/wx_key.dll');
for (const directory of ['core','onebot','adapters/wechat','dsh']) addTree('components/qq-bridge/src/' + directory, name => !name.includes('.test.'));
for (const name of ['social-bridge.js','role-card.js','adapters/base-adapter.js']) add('components/qq-bridge/src/' + name);
add('components/qq-bridge/LICENSE');
add('components/qq-bridge/src/safe-fetch.js');
addTree('packages/extension-runtime', (name, dir) => dir || /\.(mjs|md)$/.test(name));
addTree('packages/plugin-api', (name, dir) => dir || /\.(mjs|md)$/.test(name));
add('docs/PLUGIN_DEVELOPMENT.md');
add('scripts/pack-plugin.mjs');
addTree('examples/plugins/chat-notes',(name,dir)=>dir||/\.(mjs|json|md)$/.test(name));
addTree('optional-extensions/fish-notebook',(name,dir)=>dir||/\.(mjs|json|md)$/.test(name));
add('optional-extensions/packages/fish-notebook-1.0.0.zip');
add('optional-extensions/packages/fish-notebook-1.0.0.zip.sha256');
add('optional-extensions/packages/README.md');
addTree('extensions/skills/meme-search', (name, dir) => dir || /\.(js|json|md)$/.test(name));
fs.writeFileSync(path.join(project, 'components/qq-bridge/package.json'), JSON.stringify({ name:'wechatagent-social-bridge', type:'module', private:true, license:'MIT' })); files.push('components/qq-bridge/package.json');
const bridgeFile = path.join(project, 'components/qq-bridge/src/social-bridge.js');
fs.writeFileSync(bridgeFile, fs.readFileSync(bridgeFile, 'utf8').replace('这是蓝色大肥鱼的 AI 接入测试。', '这是微信助手的 AI 接入测试。'));
addTree('packages/dsh-social-bridge-plugin', (name, dir) => name !== '.git' && name !== '.bin' && (dir || /\.(mjs|js|json|yml|yaml|md|txt|ts|map)$/.test(name) || /^LICENSE|^NOTICE/.test(name)));
fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name:'wechatagent-runtime', version, type:'module', private:true, scripts:{'media:prepare':'node scripts/prepare-local-media.mjs --download','media:check':'node scripts/prepare-local-media.mjs'} }, null, 2)); files.push('package.json');

const runtimeRevision=prepareInstallerRuntime(path.join(stage,'runtime'));
// Build native helpers inside the staging tree, using the reviewed sources.
const helpers = [
  ['qt-actions','ui-host/WechatQtActions.exe'], ['account-probe','ui-host/WechatAccountProbe.exe'],
  ['voice-probe','ui-host/WechatVoicePreview.exe'], ['audio-probe','audio-probe/AudioRouteProbe.exe'],
  ['visual-probe','ui-host/WechatVisualProbe.exe'], ['frame-capture','ui-host/WechatFrameCapture.exe'],
  ['draft-probe','ui-host/WechatDraftProbe.exe'], ['ui-host','ui-host/WechatUiHost.exe'],
  ['accessibility-gate','ui-host/WechatAccessibilityGate.exe'], ['background-controls','ui-host/WechatBackgroundControls.exe'],
  ['uia-offscreen-host','ui-host/WechatUiaOffscreenHost.exe'], ['offscreen-focus','ui-host/WechatOffscreenFocus.exe'],
];
const nativeFiles = {};
for (const [buildName,relative] of helpers) {
  const built=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(project,'scripts','build-'+buildName+'.ps1')],{windowsHide:true,cwd:project,stdio:'inherit'});
  if(built.status!==0)throw Error('Failed to build UI component: '+buildName);
  const file=path.join(project,'state',relative);
  copyFile(file,path.join(vendor,'ui',relative));
  nativeFiles[relative]=sha(fs.readFileSync(file));
}
const scratch=path.resolve(project,'state');
if(path.dirname(scratch)!==path.resolve(project))throw Error('Invalid native staging path.');
fs.rmSync(scratch,{recursive:true,force:true});
const pluginTemplate = path.join(project, 'packages/dsh-social-bridge-plugin/cordis.patch.yml');
fs.writeFileSync(pluginTemplate, fs.readFileSync(pluginTemplate, 'utf8')
  .replace(/file:\/\/\/[^"'\r\n]*\/dsh-social-bridge-plugin\/([A-Za-z0-9_-]+\.mjs)(?:\?[^"'\r\n]*)?/g, 'dsh-social-bridge-plugin/$1'));
const fileList = [...new Set(files)].sort();
const sourceHashes = Object.fromEntries(fileList.map(file => [file, sha(fs.readFileSync(path.join(project,file)))]));
const desktopHashes = Object.fromEntries(fs.readdirSync(appDir).filter(file=>fs.statSync(path.join(appDir,file)).isFile()).sort().map(file=>[file,sha(fs.readFileSync(path.join(appDir,file)))]));
const buildId = sha(Buffer.from(JSON.stringify({sourceHashes,desktopHashes,runtimeRevision,nativeFiles}))).slice(0,16);
fs.writeFileSync(path.join(project, 'deployment.json'), JSON.stringify({ version, buildId, builtAt:new Date().toISOString(), runtimeRevision, sourceHashes, nativeFiles, files:fileList, presets:presetNames.map(name=>name.slice(0,-3)), node:process.version,  dshBundled:false,dshSdkVersion:DSH_SDK_VERSION,dshInstallUrl:DSH_INSTALL_URL, privateAccountDataIncluded:false, authorization:'Maintainer confirmed redistribution authorization for all currently used components and requested all current role files as bundled presets on 2026-10-05.' }, null, 2));
// No personal data can enter the deployment template or vendor programs.
for (const file of fs.readdirSync(project, { recursive:true })) {
  const relative = String(file).replaceAll('\\','/');
  if (/^state\/|(^|\/)wechatagent\.json$|social-dsh-token|native-token|\.env$|WeFlow-config\.json$/.test(relative)) throw new Error('Private file entered the release: ' + relative);
}
const notices = 'WeChatAgent '+version+'\n\nBundled components: Electron, Node.js, desktop UI helpers, MIT weflow-cli NT reader sources and the WeFlow reader component, MIT Social Bridge sources and the DSH bridge plugin/SDK. WeChat and DSH are installed separately.\n\nElectron/Chromium and vendor notices are retained with their programs. Refer to project/LICENSES.md for attribution.\n';
fs.writeFileSync(path.join(appDir, 'THIRD-PARTY-NOTICES.txt'), notices);
copyFile(path.join(root, 'LICENSE'), path.join(appDir, 'LICENSE.txt'));
const { build, Platform, Arch } = require('electron-builder');
const templateDir = path.dirname(require.resolve('app-builder-lib/package.json')) + '/templates/nsis';
const customNsis = path.join(stage, 'nsis-templates'); fs.mkdirSync(customNsis, { recursive:true });
copyTree(templateDir, customNsis);
let multiUser = fs.readFileSync(path.join(templateDir, 'multiUser.nsh'), 'utf8');
const originalFolderLookup = /      System::Store S[\s\S]*?      System::Store L\r?\n/;
if (!originalFolderLookup.test(multiUser)) throw new Error('NSIS per-user path template differs; inspect before building.');
multiUser = multiUser.replace(originalFolderLookup, '      # Current-user LocalAppData avoids the old System::Store memory fault.\n');
fs.writeFileSync(path.join(customNsis, 'multiUser.nsh'), multiUser);
const assistedFile=path.join(customNsis,'assistedInstaller.nsh');
const assisted=fs.readFileSync(assistedFile,'utf8');
fs.writeFileSync(assistedFile,singleDirectoryTemplate(assisted));
// User data is outside the install directory and deleteAppDataOnUninstall is
// false. Standard removal avoids the legacy uninstaller's atomic rename,
// which fails across drives and on long bundled LibreOffice file paths.
const installUtilFile = path.join(customNsis,'include/installUtil.nsh');
let installUtil = fs.readFileSync(installUtilFile,'utf8');
const updatedArgument = '    StrCpy $0 "$0 --updated"';
if (!installUtil.includes(updatedArgument)) throw new Error('NSIS update template differs; inspect before building.');
installUtil = installUtil.replace(updatedArgument,'    # Keep AppData and use standard removal for large vendor runtimes.');
fs.writeFileSync(installUtilFile,installUtil);
const uninstallFile=path.join(customNsis,'uninstaller.nsh');
let uninstall=fs.readFileSync(uninstallFile,'utf8');
if(!uninstall.includes('    RMDir /r $INSTDIR'))throw new Error('NSIS removal template differs; inspect before building.');
uninstall=uninstall.replace('    RMDir /r $INSTDIR','    RMDir /r $INSTDIR\n    # Remove paths beyond MAX_PATH after ordinary files.\n    RMDir /r "\\\\?\\$INSTDIR"');
fs.writeFileSync(uninstallFile,uninstall);
// Redirect this build's templates without modifying installed builder files;
// keep its standard installer/uninstaller generation and relative includes.
require('app-builder-lib/out/targets/nsis/nsisUtil').nsisTemplatesDir = customNsis;
process.env.ELECTRON_BUILDER_CACHE = path.join(root, 'state', 'installer-cache', 'electron-builder');
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL ??= '1';
await build({ targets:Platform.WINDOWS.createTarget('nsis', Arch.x64), config: {
  appId:'local.wechatagent.desktop', productName:'WeChatAgent', artifactName:'WeChatAgent-Setup-${version}-${arch}.${ext}',
  buildVersion:version.endsWith('-fix')?version.replace(/-fix$/,'.1'):undefined,
  directories:{app:appDir, output:path.join(root,'release','installer'), buildResources:appDir},
  electronDist:path.join(root,'node_modules/electron/dist'), electronVersion:'41.1.1',
  asar:false, npmRebuild:false, buildDependenciesFromSource:false, files:['**/*'],
  afterPack: async context => embedExecutableIcon(path.join(context.appOutDir, 'WeChatAgent.exe'), path.join(appDir, 'icon.ico'), require('resedit')),
  extraResources:[{from:project,to:'project'},{from:path.join(stage,'runtime'),to:'runtime',filter:['**/*','!**/__pycache__/**','!**/*.pyc']},{from:vendor,to:'vendor'}],
  win:{target:['nsis'], icon:path.join(appDir,'icon.ico'), signAndEditExecutable:false, requestedExecutionLevel:'asInvoker'},
  nsis:{include:path.join(root,'apps/console-desktop/installer-storage.nsh'),installerIcon:path.join(appDir,'icon.ico'), uninstallerIcon:path.join(appDir,'icon.ico'), oneClick:false, perMachine:false, allowElevation:false, allowToChangeInstallationDirectory:true, createDesktopShortcut:true, createStartMenuShortcut:true, deleteAppDataOnUninstall:false, differentialPackage:false, runAfterFinish:false, installerLanguages:['zh_CN','en_US'], language:'2052', license:path.join(appDir,'LICENSE.txt')},
  compression:'normal', publish:null,
} });
console.log('Installer built in release/installer');
