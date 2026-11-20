import {feedbackSnapshot,saveFeedback} from '../packages/dsh-social-bridge-plugin/assistant-feedback.mjs';
import {createMemoryConsole} from './memory-console.mjs';
import {fishNotebookSnapshot} from './fish-notebook-console.mjs';
import fs from 'node:fs';
import {createPersonaCategories} from './persona-categories.mjs';
import {createUpdateChecker} from './update-check.mjs';
import {builtinCatalog,applyBuiltinUpdate,extensionPresentation,allowedKeys} from './extension-status.mjs';
import {readSpeechProviderView,saveSpeechProviders} from './speech-provider-settings.mjs';
import * as localAsrService from './local-asr-service.mjs';
import {checkSpeechProvider} from './speech-provider-check.mjs';
import {pluginConfigUi} from './plugin-config-ui.mjs';
import {syncInstalledUiRuntime} from './installed-ui-runtime.mjs';
import {pluginCatalog,updatePlugin,archivePlugin,packageFiles,inspectPackage} from '../packages/plugin-api/catalog.mjs';
import {PluginInstaller} from '../packages/plugin-api/installer.mjs';
import {packZip} from '../packages/plugin-api/zip.mjs';
import {bundledExtensionCatalog,saveBundledExtension} from './bundled-extensions.mjs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateConfig, projectRoot, migrateRetiredSender, migrateRetiredGroupReplyProbability } from './project-config.mjs';
import { conversationId } from './onebot-identity.mjs';
import { runConsoleCommand, taskFailureMessage, hasReaderEventGap, readerGapMessage, windowsPowerShellEnvironment, windowsPowerShellExecutable } from './console-process.mjs';
import { personaError,personaReferences } from '../public/console/persona-files.mjs';
import {applyChatSettings} from '../public/console/conversation-settings.mjs';
import { runReaderSetup, readerSetupMessage } from './reader-setup.mjs';
import { dshConfigurationMatches,sameProjectPath } from './dsh-configuration.mjs';
import { createProcessRecovery,startupConflictPorts } from './process-recovery.mjs';
import { activeReaderAccount } from './reader-account-state.mjs';
import {createBotControls} from './bot-controls.mjs';
import {previewUiReaderRecovery,recoverUiReader} from './ui-reader-recovery.mjs';
import {createUiRuntimeControls} from './ui-runtime-controls.mjs';
import {createUiDeliveryControls} from './ui-delivery-controls.mjs';
import {readerComponentStatus,importReaderComponent} from './prepare-reader-component.mjs';

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fault = (message, status = 400) => Object.assign(new Error(message), { status });
const atomic = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
};
const optionalJson = (file, fallback = {}) => fs.existsSync(file) ? readJson(file) : fallback;
const roleName = name => typeof name === 'string' && /^[^\\/\0.][^\\/\0]{0,60}$/.test(name) && !name.includes('..') && !/[<>:"|?*\r\n]/.test(name) && !/[. ]$/.test(name) && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name);
const portOpen = port => new Promise(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port });
  const finish = value => { socket.destroy(); resolve(value); };
  socket.setTimeout(600); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(false));
});

export function validateConsoleConfig(config, root) {
  migrateRetiredGroupReplyProbability(config);
  try { validateConfig(config); } catch (error) {
    const translations = [
      [/distinct|ports|Required ports/, '端口必须为 1024–65535 的整数，且不能互相重复。'],

      [/WeChat executable path/, '请选择本机微信程序的绝对路径。'],
      [/persona/, '人格名称不能包含路径、点号前缀或无效字符。'],
      [/OneBot IDs/, '聊天 ID 必须是有效的正整数。'],
      [/nicknames|Python/, '请填写 Python 程序位置与至少一个账号昵称。'],
      [/provider|model/, '请填写有效的模型提供方与模型标识。'],
      [/wake_mode/, '请选择自然参与或唤醒后回复。'],

      [/sticker/, '表情发送与标签缓存必须使用开关值，聊天覆盖设置需要有效聊天 ID。'],
      [/webReader/, '网页阅读设置必须是开关值。'],
      [/search/, '请检查联网搜索开关、聊天 ID 和单轮次数范围。每轮搜索次数为 1–3，摘要长度为 256–3000 字符。'],
      [/proactive/, '请检查主动聊天开关、内容方向、时间段和间隔。时间为 HH:MM，主动间隔为 30–1440 分钟。'],
      [/context/, '请检查上下文压缩设置：阈值为 4,000–2,000,000 token，空闲等待为 15–3,600 秒；单个聊天填 0 可关闭。'],
    ];
    throw fault(translations.find(([pattern]) => pattern.test(error.message))?.[1] ?? '配置格式无效，请检查连接与回复设置。');
  }
  for (const value of [config.runtime.python, config.runtime.dshDesktop ?? '']) {
    if (typeof value !== 'string' || /[\0\r\n"]/.test(value) || value.length > 1024) throw fault('程序路径包含无效字符。');
  }
  for (const list of [config.account.nicknames, config.wechat.wake_words]) {
    if (!Array.isArray(list) || list.length > 50 || list.some(v => typeof v !== 'string' || !v.trim() || v.length > 100)) throw fault('昵称与唤醒词必须是有效文字，每项不超过 100 字。');
  }
  const ranges = { batch_ms: [0, 60000], min_interval_ms: [0, 3600000], private_min_interval_ms: [0, 3600000], max_per_minute: [1, 1000], max_per_ten_minutes: [1, 10000] };
  for (const [key, [low, high]] of Object.entries(ranges)) {
    if (!Number.isInteger(config.social?.[key]) || config.social[key] < low || config.social[key] > high) throw fault(`回复频率 ${key} 必须在 ${low}–${high} 范围内。`);
  }
  for (const [key, value] of Object.entries(config.persona.chats ?? {})) {
    if (!/^wechat:(private|group):[1-9]\d*$/.test(key) || !roleName(value)) throw fault('聊天人格映射无效。');
  }
  for (const name of [config.persona.default, ...Object.values(config.persona.chats ?? {})]) {
    if (!roleName(name) || !fs.existsSync(path.join(root, 'roles', name + '.md'))) throw fault(`找不到人格「${name}」，请先在“人格”页面创建。`);
  }
  for (const key of ['allowStickerCdn', 'allowStickerCdnAlias']) {
    if (typeof config.wechat.media?.[key] !== 'boolean') throw fault('图片设置必须是开关值。');
  }
  return config;
}

import {allowedConversation,validateConversationSettings,conversationWorkMode} from '../packages/dsh-social-bridge-plugin/conversation-policy.mjs';
import {selectedWechat} from '../packages/dsh-social-bridge-plugin/ui-selection-policy.mjs';
export function createConsole({ root = projectRoot, port = 3210, runner, readerSetup = runReaderSetup, fetchImpl = fetch, nodeExecutable = process.execPath, filePicker, onQuit, processProbe, processStop, botControls, localAsr = localAsrService, uiRuntimeControls, uiDeliveryControls, componentStatus = readerComponentStatus } = {}) {
  const robot=botControls??createBotControls({root});
  const runtimeControls=uiRuntimeControls??createUiRuntimeControls({root});
  const deliveryControls=uiDeliveryControls??createUiDeliveryControls({root});
  const updates=createUpdateChecker({root,fetchImpl});
  const publicDir = path.join(projectRoot, 'public', 'console');
  const pluginInstaller=new PluginInstaller(root);
  const personaCategories=createPersonaCategories(root);
  const categorySnapshot=()=>{try{return personaCategories.read();}catch(error){return {categories:[],assignments:{},revision:null,error:error.message};}};
  const configFile = path.join(root, 'config', 'wechatagent.json');
  const preferenceFile = path.join(root, 'state', 'console-state.json');
  const deletedPersonaFile = name => path.join(root,'state','deleted-personas',hash(name.toLocaleLowerCase())+'.json');
  const readerFile = path.join(root, 'state', 'weflow', 'WeFlow-config.json');
  const readerRevision = () => hash(JSON.stringify(optionalJson(readerFile)));
  const readerVerified = () => optionalJson(preferenceFile).readerVerifiedRevision === readerRevision();
  const csrf = crypto.randomBytes(32).toString('hex');
  const jobs = new Map(); let activeJob = null; let latestJob = null; let protectingCredential = false, choosingFile = false;
  let readerGapResolved=false;
  let processRecoveryBusy=false;
  let shutdownPromise=null,shuttingDown=false;
  const processRecovery=createProcessRecovery({root,probe:processProbe,stop:processStop});
  let statusPromise; let statusTime = 0;
  const memoryView=createMemoryConsole({root,configFor:()=>{const config=snapshot().config;return {...config,wechat:selectedWechat(root,config.wechat)};},plugin});
  const snapshot = () => {
    const raw = fs.readFileSync(fs.existsSync(configFile) ? configFile : path.join(root, 'config', 'wechatagent.example.json'), 'utf8');
    const config = JSON.parse(raw.replace(/^\uFEFF/, ''));
    migrateRetiredSender(config);
    migrateRetiredGroupReplyProbability(config);
    return { config, revision: hash(raw) };
  };
  const chatPolicy=config=>selectedWechat(root,config.wechat);
  const targetView=async()=>robot.targets?robot.targets():(await robot.snapshot()).targets;
  const safeText = input => {
    let text = String(input ?? '');
    const tokenFile = path.join(root, 'state/social-dsh-token.txt');
    if (fs.existsSync(tokenFile)) { const token = fs.readFileSync(tokenFile,'utf8').trim(); if (token) text = text.split(token).join('[已隐藏]'); }
    let io = {}; try { io = optionalJson(path.join(root, 'state', 'wechat-io-config.json')); } catch {}
    if (io.reader_token) text = text.split(io.reader_token).join('[已隐藏]');
    return text.replace(/(Bearer\s+)[^\s"']+/gi, '$1[已隐藏]').replace(/((?:decryptKey|access_token|api[_-]?key|password|reader_token)\s*[":=]+\s*")[^"]*/gi, '$1[已隐藏]').replace(/userdpapi:[A-Za-z0-9+/=]+/g, '[已隐藏凭据]').replace(/\b[0-9a-f]{64}\b/gi, '[已隐藏凭据]');
  };
  const backup = file => {
    if (!fs.existsSync(file)) return;
    const dir = path.join(root, 'state', 'console-backups');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(file, path.join(dir, `${path.basename(file)}.${Date.now()}.${crypto.randomBytes(3).toString('hex')}.bak`));
  };
  const markPending = (dsh = false) => {
    const previous = optionalJson(preferenceFile);
    atomic(preferenceFile, { ...previous, pendingApply: true, dshRestartRequired: previous.dshRestartRequired || dsh });
    statusTime = 0;
  };
  const assertIdle = () => { if(shuttingDown)throw fault('正在退出并停止后台服务，请等待操作完成。',409);if (activeJob || protectingCredential || processRecoveryBusy) throw fault('有操作正在进行，请等它完成后再保存或执行其他操作。', 409); };
  function shutdown() {
    if(shutdownPromise)return shutdownPromise;
    assertIdle();shuttingDown=true;let output='';
    shutdownPromise=Promise.resolve().then(()=>execute({...command('stop'),timeoutMs:70000},chunk=>{output=safeText(output+chunk.toString()).slice(-12000);})).then(async code=>{
      const logDir=path.join(root,'state','logs');fs.mkdirSync(logDir,{recursive:true});
      fs.writeFileSync(path.join(logDir,'shutdown.log'),new Date().toISOString()+'\n'+output+'\nexit='+code+'\n');
      if(code!==0)throw fault('后台服务未能全部停止。请查看运行日志 shutdown.log 后重试退出。',503);
      try{await robot.close?.();}catch{throw fault('语音服务尚未确认停止，请查看语音服务日志后重试退出。',503);}
      await localAsr.stopLocalAsr({root});
      statusTime=0;return {ok:true};
    }).catch(error=>{shuttingDown=false;shutdownPromise=null;throw error;});
    return shutdownPromise;
  }
  async function remote(url, token, timeout = 2200) {
    const response = await fetchImpl(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw fault('连接服务暂不可用。请检查服务是否启动。', 503);
    const data = await response.json();
    if (data.success === false) throw fault('读取服务返回错误，请查看运行日志。', 503);
    return data;
  }
  async function reader(route) {
    const { config } = snapshot(); const io = optionalJson(path.join(root, 'state', 'wechat-io-config.json'));
    if (!io.reader_token) throw fault('读取连接尚未准备，请先启动服务。', 503);
    return remote(`http://127.0.0.1:${config.ports.weflow}${route}`, io.reader_token, 5000);
  }
  async function stickerManager(route,body) {
    const {config}=snapshot(),io=optionalJson(path.join(root,'state','wechat-io-config.json'));
    if(!io.reader_token)throw fault('请先连接微信并启动读取服务，再管理表情包。',503);
    let response;
    try{response=await fetchImpl(`http://127.0.0.1:${config.ports.weflow}/api/v1/stickers/manage${route}`,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+io.reader_token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});}
    catch{throw fault('表情池暂时无法连接，请确认读取服务已启动。',503);}
    const data=await response.json();
    if(!response.ok){
      const messages={STICKER_MANAGER_ACCOUNT_CHANGED:'微信账号已变化，请刷新表情管理页面后重试。',STICKER_MANAGER_CHANGED:'表情池已更新，请刷新列表后重试。',STICKER_MANAGER_BUSY:'已有图片正在导入，请稍后重试。',STICKER_MANAGER_FULL:'表情池已满 50 张，请先删除不需要的表情再添加。',STICKER_MANAGER_TOO_LARGE:'每张图片不能超过 8 MB。',STICKER_MANAGER_INVALID_IMAGE:'图片无效或过大。支持 GIF、PNG、JPG、WebP，最多 64 帧、边长不超过 4096 像素。',STICKER_MANAGER_INVALID:'请检查名称、描述和标签：名称与描述最多 120 字，标签最多 6 个、每个最多 16 字。',STICKER_MANAGER_NOT_FOUND:'这张表情已移除，请刷新列表。',STICKER_MANAGER_INTEGRITY:'图片校验失败，原有表情未修改。'};
      throw fault(messages[data.error]??(response.status===404?'读取服务尚未加载表情管理功能，请退出重开 WeChatAgent 并重启服务。':'表情管理暂时不可用，请查看读取服务日志。'),[400,404,409,413].includes(response.status)?response.status:503);
    }
    return data;
  }
  async function plugin(route,body) {
    const { config } = snapshot();
    const tokenFile = path.join(root, 'state', 'social-dsh-token.txt');
    if (!fs.existsSync(tokenFile)) throw fault('模型连接尚未准备，请先打开 DSH 并启用本项目插件。', 503);
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    const health = await remote(`http://127.0.0.1:${config.ports.dshPlugin}/health`, token);
    if (health.project !== 'WeChatAgent' || !sameProjectPath(health.projectRoot,root)) throw fault('DSH 插件连接到其他项目，请启用当前项目插件。', 503);
    if(body===undefined)return remote(`http://127.0.0.1:${config.ports.dshPlugin}${route}`, token, 5000);
    const response=await fetchImpl(`http://127.0.0.1:${config.ports.dshPlugin}${route}`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
    const result=await response.json();
    if(!response.ok){const messages={SESSION_GROUP_SERVICE_UNAVAILABLE:'DSH 工作区服务尚未就绪，请从托盘完整退出并重开 DSH。',SESSION_GROUP_INVALID_NAME:'分组名称需要 1–60 个字符。',SESSION_GROUP_INVALID_PATH:'请选择一个已存在、可访问的完整目录。',SESSION_GROUP_CHANGED:'工作区列表已变化，请刷新会话页面后重试。',SESSION_GROUP_NOT_FOUND:'工作区已被移除，请刷新后重新选择。',SESSION_GROUP_DUPLICATE_NAME:'DSH 中已有同名工作区，请换一个名称。',SESSION_GROUP_NOT_EMPTY:'此工作区仍有未归档的 DSH 会话，请先移走它们。',SESSION_GROUP_SESSION_BUSY:'此聊天正在回复或维护，请稍后再移动。',SESSION_GROUP_SESSION_CHANGED:'当前会话已变化，请刷新后重新移动。',SESSION_GROUP_ACCOUNT_CHANGED:'微信账号已切换，请重开 DSH 后重试。',SESSION_GROUP_CHAT_NOT_ALLOWED:'请选择聊天范围中已保存的聊天。',SESSION_GROUP_CONFIRM_REQUIRED:'请确认跨目录移动时保留历史的方式。',SESSION_GROUP_SOURCE_UNAVAILABLE:'原会话的工作目录无法访问，请恢复该目录后再移动。'};throw fault(messages[result.error]??(route.startsWith('/plugin-actions/')||route.startsWith('/fish-notebook/')?'插件操作暂未完成，请检查插件授权并确认 DSH 已加载新版宿主。':'工作区操作未完成，原会话仍保留。请检查 DSH 运行日志后重试。'),[400,404,409].includes(response.status)?response.status:503);}
    return result;
  }
  function buffered() {
    const buffer = optionalJson(path.join(root, 'state', 'social-messages.json'), { chats: {} });
    let member={chats:{}};
    try{const account=activeReaderAccount(root);member=optionalJson(path.join(root,'state/accounts',account.id||account.legacyId||'legacy','assistant-group-chat.json'),member);}catch{}
    const rows = [buffer,member].flatMap(item=>Object.entries(item.chats??{}).flatMap(([key,messages])=>messages.map(m=>({...m,key}))));
    return { buffer, rows,chatCount:new Set([...Object.keys(buffer.chats??{}),...Object.keys(member.chats??{})]).size };
  }
  async function getStatus() {
    if (statusPromise && Date.now() - statusTime < 3000) return statusPromise;
    statusTime = Date.now();
    statusPromise = (async () => {
      const { config } = snapshot();
      const io = optionalJson(path.join(root, 'state', 'wechat-io-config.json'));
      const tokenFile = path.join(root, 'state', 'social-dsh-token.txt');
      const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
      const results = await Promise.allSettled([
        io.reader_token ? remote(`http://127.0.0.1:${config.ports.weflow}/api/v1/reader/status`, io.reader_token) : Promise.reject(),
        remote(`http://127.0.0.1:${config.ports.adapter}/status`),
        token ? remote(`http://127.0.0.1:${config.ports.dshPlugin}/health`, token) : Promise.reject(),
        portOpen(config.ports.onebot),
      ]);
      const value = index => results[index].status === 'fulfilled' ? results[index].value : null;
      const readerState = value(0), adapter = value(1), health = value(2);
      const matchesDsh=dshConfigurationMatches(root,snapshot().config,health);
      if(optionalJson(preferenceFile).dshRestartRequired && matchesDsh)atomic(preferenceFile,{...optionalJson(preferenceFile),dshRestartRequired:false});
      const dshReady = health?.ok === true && health.project === 'WeChatAgent' && sameProjectPath(health.projectRoot,root) && health.contextMode === 'native-session-v1' && health.behaviorPolicy === 'local-config-only-v1' && health.imageInput === 'native-attachment-v1' && (!optionalJson(preferenceFile).dshRestartRequired || matchesDsh);
      const uiIdentity = adapter?.backend === 'wechat-ui' && adapter?.project === 'WeChatAgent' && sameProjectPath(adapter?.projectRoot, root);
      const readerReady = uiIdentity && adapter?.reader_connected === true;
      const senderReady = uiIdentity && adapter?.ready === true;
      const bridgeReady = !!value(3) && adapter?.ob_connected === true && senderReady && readerReady;
      const ready = readerReady && bridgeReady && dshReady;
      const running = !!readerState || !!adapter || !!value(3);
      const gap = !readerReady && (hasReaderEventGap(readerState?.lastError) || uiIdentity && hasReaderEventGap(adapter.last_error) ||
        !adapter && !readerGapResolved && lastStartHadReaderGap(running));
      const { rows } = buffered();
      const services = [
        { id: 'reader', label: '微信读取', ready: readerReady, detail: readerReady ? '数据库可读，消息同步正常' : gap ? '读取中断，请检查离线消息的补读进度。' : readerState?.lastError ? '读取异常，请重新连接并验证' : readerFailureDetail(), ...(gap && {recovery:'reader-gap'}), port: config.ports.weflow },
        { id: 'bridge', label: '消息桥接', ready: bridgeReady, detail: bridgeReady ? '界面发送服务已连接。' : senderReady ? '等待消息桥接连接' : '等待界面发送服务连接，请检查微信窗口。', port: config.ports.adapter },
        { id: 'dsh', label: '模型连接', ready: dshReady, detail: dshReady ? 'DSH 插件已连接' : '打开 DSH 并启用本项目插件', port: config.ports.dshPlugin },
      ];
      return { ready, running, services, lastError: safeText(adapter?.last_error ?? ''),
        stats: { received: rows.filter(m => !m.outgoing).length, sent: rows.filter(m => m.outgoing).length, pending: rows.filter(m => !m.outgoing && !m.processed).length, chats: buffered().chatCount },
        recent: rows.sort((a, b) => b.timestamp - a.timestamp).slice(0, 6).map(m => ({ key: m.key, name: m.conversation_name, text: m.text?.slice(0, 100), outgoing: m.outgoing, timestamp: m.timestamp })),
        ...optionalJson(preferenceFile), activeJob: activeJob ? jobs.get(activeJob) : null, latestJob: latestJob ? jobs.get(latestJob) : null, updatedAt: Date.now() };
    })();
    return statusPromise;
  }
  function command(action, body = {}) {
    const ps = (file, ...args) => ({ exe: windowsPowerShellExecutable(), args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'console-powershell.ps1'), '-ScriptPath', path.join(root, 'scripts', file), '-ArgumentsBase64', Buffer.from(JSON.stringify(args), 'utf8').toString('base64')] });
    const node = (file, ...args) => ({ exe: nodeExecutable, args: [path.join(root, 'scripts', file), ...args] });
    if (action === 'reader-connect') {
      if(!componentStatus({root}).ready)throw fault('请先在本页校验并导入本机读取组件，再连接微信。',409);
      if (body.revision !== readerRevision()) throw fault('读取配置已变化，请重新载入后再连接。', 409);
      if (typeof body.dbPath !== 'string' || typeof body.myWxid !== 'string' || !body.dbPath.trim() || !body.myWxid.trim() || body.decryptKey) throw fault('请明确选择本机账号目录；界面发送模式使用本机受保护凭据，无需填写密钥。');
      const executable = snapshot().config.runtime.wechatExecutable || optionalJson(path.join(root, 'state/secondary-deployment.json')).wechatExecutable || optionalJson(path.join(root,'state/ui-runtime/qt-visual.json')).executable;
      if (typeof executable !== 'string' || !path.isAbsolute(executable)) throw fault('请先配置本机微信程序位置。');
      return node('reader-local-prepare.mjs', '--db-path', body.dbPath.trim(), '--account', body.myWxid.trim(), '--wechat', executable, '--connect');
    }
    if (action === 'reader-check') return node('ui-service.mjs', '--check');
    if (['start', 'stop', 'restart', 'prepare'].includes(action)) return ps('manage.ps1', action);
    if (action === 'ui-components-prepare') return ps('prepare-ui-components.ps1');
    if (action === 'reader-local-connect') return node('reader-local-setup.mjs', '--connect-and-activate');
    if (action === 'reader-local-activate') return node('reader-local-setup.mjs', '--activate');
    if (action === 'setup') return ps(fs.existsSync(path.join(root, 'config', 'distribution.json')) ? 'check-runtime.ps1' : 'setup.ps1');
    if (action === 'dsh-open') return ps('launch-dsh.ps1');
    if (['sessions-configure', 'sessions-compact'].includes(action)) {
      const key = body.conversationKey;
      const config = snapshot().config;
      const match = /^wechat:(private|group):([1-9]\d*)$/.exec(key ?? '');
      if (!match || !allowedConversation(chatPolicy(config),key)) throw fault('请从已允许的聊天中选择需要管理的会话。');
      return node('manage-dsh-sessions.mjs', action === 'sessions-compact' ? 'compact' : 'configure', key);
    }
    throw fault('不支持此操作。');
  }
  const execute = runner ?? ((spec, onOutput) => runConsoleCommand(spec, onOutput, { cwd: root, timeoutMs: spec.timeoutMs }));
  function lastStartHadReaderGap(running) {
    const startup=[...jobs.values()].findLast(job=>job.action==='start'||job.action==='restart');
    if(startup)return startup.state==='failed'&&startup.recovery==='reader-gap';
    if(!running)return false;
    // The supervisor writes the Reader's stop code to the adapter log. A
    // reopened console has no in-memory startup job for the surviving bridge.
    const file=path.join(root,'state','logs','adapter.stderr.log');
    try{
      const stat=fs.statSync(file);
      return stat.isFile() && stat.size<=8192 && fs.readFileSync(file,'utf8').trim()==='READER_TARGET_EVENT_GAP';
    }catch{return false;}
  }
  function readerFailureDetail() {
    const file = path.join(root, 'state', 'logs', 'reader.stderr.log');
    if (!fs.existsSync(file)) return '请在首次配置中连接并验证微信';
    const output = fs.readFileSync(file, 'utf8').slice(-8000);
    return output.trim() ? taskFailureMessage(output, 1) : '等待读取服务启动';
  }
  function startJob(body) {
    assertIdle();
    const localConnect = body.action === 'reader-connect';
    const checkRevision = readerRevision();
    const initialConfigRevision = snapshot().revision;
    const spec = command(body.action, body);
    spec.timeoutMs = localConnect || ['setup','ui-components-prepare'].includes(body.action) ? 1200000 : ['start', 'restart'].includes(body.action) ? 180000 : body.action === 'reader-local-connect' ? 240000 : 150000;
    const id = crypto.randomUUID();
    const job = { id, action: body.action, state: 'running', startedAt: Date.now(), output: '', exitCode: null };
    jobs.set(id, job); activeJob = id; latestJob = id;
    if(['start','restart'].includes(body.action))readerGapResolved=false;
    while (jobs.size > 30) jobs.delete(jobs.keys().next().value);
    const output = chunk => { job.output = safeText(job.output + chunk.toString()).slice(-40000); };
    Promise.resolve().then(() => execute(spec, output)).then(async code => {
      job.exitCode = code; job.state = code === 0 ? 'succeeded' : 'failed';
      if (code !== 0 && ['start', 'restart'].includes(body.action) && /reader exited/.test(job.output)) {
        const file = path.join(root, 'state', 'logs', 'reader.stderr.log');
        if (fs.existsSync(file)) output('\n读取器错误：\n' + fs.readFileSync(file, 'utf8').slice(-8000));
      }
      if (code !== 0 && !job.message) job.message = taskFailureMessage(job.output, code);
      if (code !== 0 && ['start','restart'].includes(body.action) && job.message===readerGapMessage) job.recovery='reader-gap';
      if (code === 0 && (localConnect || ['reader-local-connect','reader-local-activate'].includes(body.action))) {
        atomic(preferenceFile, { ...optionalJson(preferenceFile), readerVerifiedRevision: readerRevision(), dshRestartRequired: true, pendingApply: true });
        job.readerConfigured = true; job.dshRestartRequired = true;
      }
      if (code === 0 && body.action === 'reader-check' && checkRevision === readerRevision()) {
        atomic(preferenceFile, { ...optionalJson(preferenceFile), readerVerifiedRevision: checkRevision }); job.readerConfigured = true;
      }
      if (code === 0 && ['start', 'restart'].includes(body.action)) {
        if(initialConfigRevision!==snapshot().revision)throw fault('设置在启动期间发生变化，请重新应用。',409);
        if(optionalJson(preferenceFile).dshRestartRequired){
          const health=await remote('http://127.0.0.1:'+snapshot().config.ports.dshPlugin+'/health',fs.readFileSync(path.join(root,'state/social-dsh-token.txt'),'utf8').trim());
          if(!dshConfigurationMatches(root,snapshot().config,health))throw fault('DSH 仍未加载当前模型或插件配置。请准备配置，从托盘完整退出并重开 DSH，然后重试。',409);
        }
        atomic(preferenceFile, { ...optionalJson(preferenceFile), pendingApply: false, dshRestartRequired:false });
      }
    }).catch(error => { job.state = 'failed'; job.exitCode = 1; job.message = error.status ? error.message : taskFailureMessage(job.output, 1);output(job.message); }).finally(() => {
      job.finishedAt = Date.now(); activeJob = null; statusTime = 0;
    });
    return job;
  }
  async function readBody(req,limit=128*1024) {
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw fault('提交内容过大。', 413); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fault('表单内容无效。'); }
  }
  async function nativeHelper(kind, input) {
    if (process.platform !== 'win32') throw fault('文件选择与凭据保护需要 Windows。');
    return new Promise((resolve, reject) => {
      const child = spawn(windowsPowerShellExecutable(), ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(projectRoot, 'scripts', 'console-native.ps1'), kind], { windowsHide: true, shell: false, env: windowsPowerShellEnvironment() });
      let output = ''; let error = '';
      child.stdout.on('data', b => { output += b.toString(); }); child.stderr.on('data', b => { error += b.toString(); });
      child.once('error', () => reject(fault('无法打开 Windows 选择窗口。')));
      child.once('close', code => code === 0 ? resolve(output.trim()) : reject(fault(kind === 'protect' ? '无法保护读取凭据。原有设置未修改。' : '文件选择失败，请手动填写路径。')));
      child.stdin.end(input ?? '');
    });
  }
  function asrRuntimeView(runtime) {
    return {loaded:!!runtime.loaded,profileId:runtime.loaded?runtime.profileId:null};
  }
  async function withAsrRuntime(settings) {
    if(settings.asr.mode!=='local')return settings;
    try {settings.localAsrRuntime=asrRuntimeView(await localAsr.localAsrStatus({root}));}
    catch {settings.localAsrRuntime={loaded:false,profileId:null,unavailable:true};}
    return settings;
  }
  async function speechView(){
    try{return await withAsrRuntime(readSpeechProviderView({root,includeLocalModels:true}));}
    catch{return {error:'无法读取本机语音服务设置。'};}
  }
  const server = http.createServer(async (req, res) => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" };
    const reply = (status, body, type = 'application/json; charset=utf-8') => { res.writeHead(status, { ...headers, 'Content-Type': type }); res.end(type.startsWith('application/json') ? JSON.stringify(body) : body); };
    try {
      const boundPort = server.address()?.port ?? port;
      const expectedHost = `127.0.0.1:${boundPort}`;
      if (req.headers.host !== expectedHost) throw fault('请通过本机控制台地址访问。', 403);
      const origin = `http://${expectedHost}`;
      if ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') throw fault('不允许其他网站访问本机控制台。', 403);
      const url = new URL(req.url, origin);
      const route = url.pathname;
      if (req.method === 'GET' && !route.startsWith('/api/')) {
        if(route==='/plugin-api.md'){res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':'attachment; filename="WeChatAgent-plugin-api-v2.md"','X-Content-Type-Options':'nosniff'});res.end(fs.readFileSync(path.join(projectRoot,'docs/PLUGIN_DEVELOPMENT.md')));return;}
        if(route==='/plugin-example.zip'){const example=path.join(projectRoot,'examples/plugins/chat-notes');inspectPackage(example);res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="chat-notes-1.0.0.zip"','X-Content-Type-Options':'nosniff'});res.end(packZip(packageFiles(example)));return;}
        if(route==='/plugin-packages/fish-notebook.zip'){const source=path.join(projectRoot,'optional-extensions/fish-notebook');inspectPackage(source);res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="fish-notebook-1.0.0.zip"','X-Content-Type-Options':'nosniff'});res.end(packZip(packageFiles(source)));return;}
        const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/console.css': ['console.css', 'text/css; charset=utf-8'], '/console.js': ['console.js', 'text/javascript; charset=utf-8'], '/persona-files.mjs': ['persona-files.mjs', 'text/javascript; charset=utf-8'], '/appearance.js': ['appearance.js', 'text/javascript; charset=utf-8'], '/appearance.css': ['appearance.css', 'text/css; charset=utf-8'], '/icons.svg': ['icons.svg', 'image/svg+xml'], '/app-icon.png': ['app-icon.png', 'image/png'], '/favicon.svg': ['app-icon.png', 'image/png'] };
        assets['/extension-market.js']=['extension-market.js','text/javascript; charset=utf-8'];assets['/extension-market.css']=['extension-market.css','text/css; charset=utf-8'];
        assets['/plugin-config-ui.mjs']=['plugin-config-ui.mjs','text/javascript; charset=utf-8'];
        assets['/speech-provider-form.mjs']=['speech-provider-form.mjs','text/javascript; charset=utf-8'];
        assets['/plugins.js']=['plugins.js','text/javascript; charset=utf-8'];assets['/plugins.css']=['plugins.css','text/css; charset=utf-8'];
        assets['/external-links.js']=['external-links.js','text/javascript; charset=utf-8'];
        assets['/sticker-manager.js']=['sticker-manager.js','text/javascript; charset=utf-8'];assets['/sticker-manager.css']=['sticker-manager.css','text/css; charset=utf-8'];
        assets['/updates.js']=['updates.js','text/javascript; charset=utf-8'];
        for(const file of ['workspace-layout.js','layout-model.mjs','session-usage.js'])assets['/'+file]=[file,'text/javascript; charset=utf-8'];
        assets['/workspace-layout.css']=['workspace-layout.css','text/css; charset=utf-8'];
        assets['/assistant-feedback.js']=['assistant-feedback.js','text/javascript; charset=utf-8'];
        assets['/memory-view.js']=['memory-view.js','text/javascript; charset=utf-8'];assets['/memory-view.css']=['memory-view.css','text/css; charset=utf-8'];
        assets['/fish-notebook.js']=['fish-notebook.js','text/javascript; charset=utf-8'];assets['/fish-notebook.css']=['fish-notebook.css','text/css; charset=utf-8'];
        assets['/conversation-settings.mjs']=['conversation-settings.mjs','text/javascript; charset=utf-8'];
        assets['/bot-controls.js']=['bot-controls.js','text/javascript; charset=utf-8'];
        assets['/reply-media.js']=['reply-media.js','text/javascript; charset=utf-8'];
        assets['/chat-targets.mjs']=['chat-targets.mjs','text/javascript; charset=utf-8'];
        assets['/delivery-queue.js']=['delivery-queue.js','text/javascript; charset=utf-8'];
        assets['/bot-controls.css']=['bot-controls.css','text/css; charset=utf-8'];
        assets['/dsh-catalog.mjs']=['dsh-catalog.mjs','text/javascript; charset=utf-8'];
        assets['/persona-delete.js']=['persona-delete.js','text/javascript; charset=utf-8'];
        assets['/persona-categories.js']=['persona-categories.js','text/javascript; charset=utf-8'];assets['/persona-categories.css']=['persona-categories.css','text/css; charset=utf-8'];
        assets['/dsh-install.mjs']=['dsh-install.mjs','text/javascript; charset=utf-8'];
        assets['/session-groups.js']=['session-groups.js','text/javascript; charset=utf-8'];assets['/session-groups.css']=['session-groups.css','text/css; charset=utf-8'];
        assets['/process-recovery.js']=['process-recovery.js','text/javascript; charset=utf-8'];assets['/process-recovery.css']=['process-recovery.css','text/css; charset=utf-8'];
        assets['/dsh-access.js']=['dsh-access.js','text/javascript; charset=utf-8'];assets['/extensions.js']=['extensions.js','text/javascript; charset=utf-8'];
        if (!assets[route]) return reply(404, { error: '页面不存在。' });
        const [file, type] = assets[route]; return reply(200, fs.readFileSync(path.join(publicDir, file)), type);
      }
      if (req.method === 'GET' && route === '/api/info') return reply(200, { project: 'WeChatAgent Console', root, version: 1, token: csrf });
      if (req.headers['x-console-token'] !== csrf) throw fault('控制台连接已更新，请刷新页面。', 401);
      if(req.method==='GET'&&route==='/api/bot-controls')return reply(200,{...await robot.snapshot(),speechProviders:await speechView()});
      if(req.method==='GET'&&route==='/api/bot-controls/interaction')return reply(200,await robot.interaction());
      if(req.method==='GET'&&route==='/api/bot-controls/speech'){
        const [voice,speechProviders]=await Promise.all([
          robot.voice().catch(error=>({error:error.message})),speechView()
        ]);
        return reply(200,{voice,speechProviders});
      }

      if(req.method==='GET'&&route==='/api/bot-controls/contacts')return reply(200,await robot.contacts({accountRef:url.searchParams.get('accountRef'),keyword:url.searchParams.get('keyword')??''}));
      if(req.method==='GET'&&route==='/api/bot-controls/voice/files')return reply(200,await robot.voiceFiles());
      if(req.method==='GET'&&route==='/api/chat-targets')return reply(200,await targetView());
      if(req.method==='GET'&&route==='/api/ui-runtime-controls')return reply(200,runtimeControls.snapshot());
      if(req.method==='GET'&&route==='/api/ui-deliveries'){
        const scoped=url.searchParams.has('conversationKey')||url.searchParams.has('accountRef');
        try{
          const scope=scoped?{conversationKey:url.searchParams.get('conversationKey'),accountRef:url.searchParams.get('accountRef')}:undefined;
          return reply(200,deliveryControls.snapshot(scope));
        }catch(error){
          if(/^UI_QUEUE_(?:CHAT_|ACCOUNT_MISMATCH)/.test(error.code??''))throw fault('聊天名单或微信账号已变化，请重新打开该聊天。',409);
          throw fault('当前账号的发送队列暂时无法读取，请检查本机微信连接。',409);
        }
      }
      if(req.method==='GET'&&route==='/api/ui-runtime-controls/voice-recovery')return reply(200,await runtimeControls.inspectVoiceRecovery());
      if(req.method==='GET'&&route==='/api/reader-component')return reply(200,componentStatus({root}));
      if(req.method==='GET'&&route==='/api/ui-runtime-controls/audio-devices'){
        try{return reply(200,await runtimeControls.audioDevices());}
        catch{throw fault('无法读取本机语音设备。请先在工具页准备界面组件，并确认已安装 VB-CABLE。',409);}
      }
      if(req.method==='GET'&&route==='/api/updates')return reply(200,await updates.check());
      if(req.method==='GET'&&route==='/api/assistant-feedback')return reply(200,feedbackSnapshot(root));
      if(req.method==='GET'&&route==='/api/memory')return reply(200,memoryView.overview());
      if(req.method==='GET'&&route==='/api/fish-notebook')return reply(200,fishNotebookSnapshot(root,snapshot(),url.searchParams));
      if(req.method==='GET'&&route==='/api/memory/members')return reply(200,memoryView.members(url.searchParams));
      if(req.method==='GET'&&route==='/api/memory/summaries')return reply(200,await memoryView.summaries(url.searchParams));
      if (req.method === 'GET' && route === '/api/config') return reply(200, { ...snapshot(), ...optionalJson(preferenceFile) });
      if(req.method==='GET'&&route==='/api/ui-reader-recovery'){
        try{return reply(200,previewUiReaderRecovery({root}));}catch(error){return reply(200,{available:false,incompleteRecovery:false,canRecover:false,gapDetected:false,backfillActive:false,lastScanAt:null,pendingCount:null,revision:null,busy:false,error:/^UI_RECOVERY_|^READER_/.test(error?.code??'')?error.code:'UI_RECOVERY_UNAVAILABLE',message:'读取配置尚未就绪，或读取记录需要核对。'});}
      }
      if(req.method==='GET'&&route==='/api/sticker-pool')return reply(200,await reader('/api/v1/stickers/pool-status'));
      if(req.method==='GET'&&route==='/api/sticker-manager')return reply(200,await stickerManager(''));
      if(req.method==='GET'&&route==='/api/sticker-manager/image'){
        const id=url.searchParams.get('id'),scope=url.searchParams.get('scope');
        if(!/^[a-f0-9]{64}$/.test(id??'')||!/^[a-f0-9]{64}$/.test(scope??''))throw fault('请选择当前账号中的表情。');
        return reply(200,await stickerManager('/image?id='+id+'&scope='+scope+'&animated='+(url.searchParams.get('animated')==='1'?'1':'0')));
      }
      if(req.method==='GET'&&route==='/api/dsh-catalog'){const key=url.searchParams.get('conversationKey');if(key&&!allowedConversation(chatPolicy(snapshot().config),key))throw fault('请先保存聊天范围。');return reply(200,await plugin('/dsh-catalog'+(key?'?conversationKey='+encodeURIComponent(key):'')));}
      if(req.method==='GET'&&route==='/api/meme-library-status'){try{return reply(200,await plugin('/meme-library/status'));}catch{return reply(200,{available:false,installed:false,reason:'DSH_PLUGIN_UNAVAILABLE'});}}
      if(req.method==='GET'&&(route==='/api/extensions'||route==='/api/plugins')){
        const saved=snapshot();let connected=false,runtime=[],pluginApiReady=false,liveFeatures=[];
        try{const health=await plugin('/health');connected=!!health.ok;pluginApiReady=health.pluginRuntime==='isolated-v2';liveFeatures=health.pluginHostFeatures??[];if(pluginApiReady)runtime=(await plugin('/extensions')).extensions??[];}catch{}
        const catalog=pluginCatalog(root,runtime);
        for(const item of catalog.plugins)Object.assign(item,pluginConfigUi(root,item));
        for(const item of catalog.plugins)if(item.enabled&&item.requiresHostFeatures.some(feature=>!liveFeatures.includes(feature))){item.loaded=false;item.active=false;item.reason='请准备配置并完整重开 DSH，加载此插件需要的新版宿主。';item.statusLabel='等待新版宿主';item.statusTone='warning';}
        if(route==='/api/plugins')return reply(200,{...catalog,runtimeConnected:pluginApiReady});
        let speechProviders=null;
        try{speechProviders=readSpeechProviderView({root});}catch{/* The card can still open the speech settings to show the read error. */}
        return reply(200,{...builtinCatalog({...saved.config,wechat:chatPolicy(saved.config)},saved.revision,connected,speechProviders),plugins:catalog.plugins,pluginRevision:catalog.revision,pluginError:catalog.error??null,canInstallZip:true,pluginApiReady});
      }
      if (req.method === 'GET' && route === '/api/deployment') {
        const distribution = optionalJson(path.join(root, 'config', 'distribution.json'));
        const readerSettings = optionalJson(path.join(root, 'state', 'weflow', 'WeFlow-config.json'));
        return reply(200, { installed: !!distribution.installed, uiMode: true, version: optionalJson(path.join(projectRoot,'package.json')).version, configured: !!readerSettings.dbPath && !!readerSettings.myWxid && !!readerSettings.decryptKey && readerVerified(), pluginPath: path.join(root, 'packages', 'dsh-social-bridge-plugin') });
      }
      if (req.method === 'GET' && route === '/api/status') return reply(200, await getStatus());
      if(req.method==='GET' && route==='/api/process-recovery'){
        assertIdle();const config=snapshot();
        if(url.searchParams.has('purpose'))throw fault('不支持的进程检查。',400);
        const status=await getStatus();
        const healthyPorts=[];
        if(status.services.find(service=>service.id==='reader')?.ready)healthyPorts.push(config.config.ports.weflow);
        if(status.services.find(service=>service.id==='bridge')?.ready)healthyPorts.push(config.config.ports.onebot,config.config.ports.adapter);
        if(status.services.find(service=>service.id==='dsh')?.ready)healthyPorts.push(config.config.ports.dshPlugin);
        const conflictPorts=startupConflictPorts(jobs.get(latestJob)?.output,Object.values(config.config.ports));
        return reply(200,await processRecovery.scan(config.config,config.revision,{healthyPorts:healthyPorts.filter(port=>!conflictPorts.includes(port))}));
      }

      if (req.method === 'GET' && route === '/api/persona-categories') return reply(200,personaCategories.read());
      if (req.method === 'GET' && route === '/api/roles') {
        const names = fs.existsSync(path.join(root, 'roles')) ? fs.readdirSync(path.join(root, 'roles')).filter(n => n.endsWith('.md') && n !== 'README.md' && roleName(n.slice(0, -3))) : [];
        return reply(200, { categories: categorySnapshot(), roles: names.map(file => { const content = fs.readFileSync(path.join(root, 'roles', file), 'utf8'); return { name: file.slice(0, -3), content, revision: hash(content) }; }) });
      }
      if (req.method === 'GET' && route === '/api/contacts') {
        const kind = url.searchParams.get('kind') === 'groups' ? 'groups' : 'private';
        const keyword = (url.searchParams.get('keyword') ?? '').slice(0, 100).trim();
        // Sessions contain selected chats only; discovery must use the contact catalog.
        const data = await reader(`/api/v1/contacts?kind=${kind}&keyword=${encodeURIComponent(keyword)}&limit=100&refresh=1`);
        const io = optionalJson(path.join(root, 'state', 'wechat-io-config.json'));
        const rows = data.contacts ?? [];
        const contacts = rows.filter(c => c.username && c.username !== io.self_wxid && (c.username.includes('@chatroom') ? 'groups' : 'private') === kind)
          .map(c => ({ name: c.remark || c.displayName || c.nickname || c.username, id: String(conversationId(c.username, c.displayName, c.conversationId)), ambiguous: c.ambiguous === true,
            ...(kind==='private'&&url.searchParams.get('includeIdentity')==='1'?{wechatId:c.username}:{}),
            ...(kind==='groups'&&c.conversationId!==undefined?{groupRef:c.username}:{}) }));
        const counts = new Map(); for (const row of contacts) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
        return reply(200, { contacts: contacts.map(c => ({ ...c, ambiguous: c.ambiguous || counts.get(c.id) > 1 })) });
      }
      if (req.method === 'GET' && route === '/api/chats') {
        const { buffer } = buffered();
        let targets;
        try{targets=await targetView();}catch(error){targets={error:error.message};}
        const chats=Object.entries(buffer.chats??{}).map(([key,rows])=>({key,name:rows.at(-1)?.conversation_name??key,lastAt:rows.at(-1)?.timestamp??0}));
        for(const target of targets?.targets??[]){
          const key='wechat:'+(target.wxid.endsWith('@chatroom')?'group':'private')+':'+target.id;
          const existing=chats.find(chat=>chat.key===key);
          if(existing)existing.name=target.label;
          else chats.push({key,name:target.label,lastAt:0});
        }
        return reply(200,{chats,targets});
      }
      if (req.method === 'GET' && route === '/api/sessions') return reply(200, await plugin('/sessions'));
      if(req.method==='GET'&&route==='/api/session-groups'){try{return reply(200,await plugin('/session-groups'));}catch{return reply(200,{available:false,groups:[],revision:''});}}
      if (req.method === 'GET' && route === '/api/job') {
        const job = jobs.get(url.searchParams.get('id')); if (!job) throw fault('此操作记录已过期。', 404); return reply(200, job);
      }
      if (req.method === 'GET' && route === '/api/logs') {
        const dir = path.join(root, 'state', 'logs');
        const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => /^[a-zA-Z0-9._-]+\.log$/.test(n)).sort() : [];
        const name = url.searchParams.get('file') ?? files.find(n => n === 'bridge.stdout.log') ?? files[0];
        if (name && !files.includes(name)) throw fault('日志文件不存在。', 404);
        let content = '';
        if (name) { const file = path.join(dir, name); const fd = fs.openSync(file, 'r'); try { const size = fs.fstatSync(fd).size; const bytes = Buffer.alloc(Math.min(size, 120000)); fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length)); content = safeText(bytes.toString('utf8')); } finally { fs.closeSync(fd); } }
        return reply(200, { files, file: name ?? '', content });
      }
      if (req.method === 'GET' && route === '/api/reader-config') {
        const settings = optionalJson(path.join(root, 'state', 'weflow', 'WeFlow-config.json'));
        return reply(200, { dbPath: /^(userdpapi:|safe:)/.test(settings.dbPath ?? '') ? '' : settings.dbPath ?? '', myWxid: /^(userdpapi:|safe:)/.test(settings.myWxid ?? '') ? '' : settings.myWxid ?? '', hasKey: !!settings.decryptKey, hasPath: !!settings.dbPath, hasAccount: !!settings.myWxid, verified: readerVerified(), revision: hash(JSON.stringify(settings)) });
      }
      if (req.method !== 'POST') throw fault('接口不存在。', 404);
      if (!req.headers['content-type']?.startsWith('application/json')) throw fault('请使用控制台表单。', 415);
      const body = await readBody(req,['/api/sticker-manager/import','/api/plugins/inspect'].includes(route)?11300000:128*1024);
      if(route==='/api/updates/check')return reply(200,await updates.check({force:true}));
      if (route === '/api/ui-reader-recovery') {
        assertIdle();
        try{
          const result=recoverUiReader({root,expectedRevision:body.expectedRevision,acknowledgeGap:body.acknowledgeGap,acknowledgeRollback:body.acknowledgeRollback});
          if(result.interruptedRecoveryRestored){readerGapResolved=true;statusTime=0;}
          return reply(200,result);
        }
        catch(error){throw fault(error.code==='UI_RECOVERY_AUTOMATIC'?'离线消息会在服务启动后自动补读，请刷新控制台查看补读进度。':/VERSION_CONFLICT/.test(error.code??'')?'恢复记录已变化，请重新载入后确认。':/BUSY|STOP_SERVICES/.test(error.code??'')?'请先停止机器人服务，再还原旧读取记录。':'读取记录无法安全恢复，原记录已保留。',409);}
      }
      if (route === '/api/jobs') return reply(202, startJob(body));
      assertIdle();
      if(route==='/api/reader-component'){
        try{return reply(200,importReaderComponent({root,source:body.source}));}
        catch(error){const messages={READER_COMPONENT_HASH_MISMATCH:'所选组件与本项目固定版本不一致，已拒绝导入。',READER_COMPONENT_SOURCE_REQUIRED:'请选择 wx_key.dll，或包含该组件的本机 WeFlow 安装目录。',READER_COMPONENT_STOP_SERVICES:'请先停止机器人及读取服务，再导入组件。'};throw fault(messages[error.code]??'无法导入这个本机组件。请选择普通本机文件或目录；原有文件不会被替换。',409);}
      }
      if(route==='/api/ui-runtime-controls/recover-voice'){
        try{return reply(200,await runtimeControls.recoverVoice(body));}
        catch(error){
          const message=/VERSION_CONFLICT/.test(error.code??'')?'语音记录或账号配置已变化，请重新检查。':/STOP_SERVICES/.test(error.code??'')?'请先停止机器人及本机录音操作，再检查语音恢复状态。':/OPTIONS_INVALID|CONFIRMATION_REQUIRED/.test(error.code??'')?'请先确认录音已结束，并已检查消息是否发出。':/BUSY/.test(error.code??'')?'本机记录正在更新，请稍后重新检查。':'语音记录暂时不能恢复，原发送记录和待确认结果已保留。';
          throw fault(message,409);
        }
      }
      if(route==='/api/ui-runtime-controls/recover-preparation'){
        try{return reply(200,runtimeControls.recoverPreparation(body));}
        catch(error){
          const messages={UI_RUNTIME_VERSION_CONFLICT:'暂停记录或账号配置已变化，请重新检查后再恢复。',UI_PREPARATION_VERSION_CONFLICT:'暂停记录已变化，请重新检查后再恢复。',UI_RUNTIME_STOP_SERVICES:'请先正常停止机器人及语音操作，再恢复发送核验。',UI_PREPARATION_SERVICE_ACTIVE:'服务状态已变化，请先停止服务。',UI_RUNTIME_OPTIONS_INVALID:'请先勾选确认微信状态，再恢复发送核验。',UI_RUNTIME_BUSY:'本机配置正在保存，请稍后重试。',UI_PREPARATION_CONTROL_BUSY:'发送记录正在更新，请稍后重新检查。'};
          throw fault(messages[error.code]??'暂停记录暂时不能恢复，请重新检查本机配置；待发消息已保留。',409);
        }
      }
      if(route==='/api/ui-runtime-controls'){
        try{return reply(200,await runtimeControls.save(body));}
        catch(error){
          const messages={UI_RUNTIME_VERSION_CONFLICT:'本机配置已变化，请重新载入后保存。',UI_RUNTIME_BUSY:'本机配置正在保存，请稍后重试。',UI_RUNTIME_AUDIO_PAIR_REQUIRED:'请选择当前枚举到的唯一 VB-CABLE 语音线路。',UI_RUNTIME_OPTIONS_INVALID:'请使用当前页面上的开关和语音设备选项。'};
          const blocker=runtimeControls.snapshot().blockers.find(row=>row.code===error.code);
          throw fault(messages[error.code]??blocker?.message??'本机配置未满足启用条件，当前设置未改变。',409);
        }
      }
      if(route==='/api/bot-controls/speech-providers/test')return reply(200,await checkSpeechProvider(root,body,{fetchImpl,signal:AbortSignal.timeout(35000)}));
      if(route==='/api/bot-controls/asr/use'||route==='/api/bot-controls/asr/stop'){
        if(shuttingDown)throw fault('正在退出并停止后台服务。',409);
        if(!body||Object.keys(body).length!==2||!Number.isSafeInteger(body.expectedVersion)||typeof body.id!=='string')
          throw fault('请选择已保存的本地识别方案。');
        const saved=readSpeechProviderView({root,includeLocalModels:true});
        if(saved.version!==body.expectedVersion||saved.asr.mode!=='local'||saved.asr.localProfileId!==body.id)
          throw fault('识别方案已变化，请重新载入后再操作。',409);
        if(route.endsWith('/use'))return reply(200,asrRuntimeView(await localAsr.useLocalAsr({root,id:body.id,expectedVersion:body.expectedVersion})));
        await localAsr.stopLocalAsr({root,id:body.id,expectedVersion:body.expectedVersion});
        return reply(200,asrRuntimeView(await localAsr.localAsrStatus({root})));
      }
      if(route==='/api/bot-controls/speech-providers'){
        let saved;
        if(body&&Object.hasOwn(body,'localVoice')){
          const {localVoice,...providers}=body;
          saved=await robot.saveSpeechSelection(providers,localVoice);
        }else saved=saveSpeechProviders({root},body);
        return reply(200,await withAsrRuntime(saved));
      }
      if(route==='/api/bot-controls/targets'||route==='/api/chat-targets')return reply(200,await robot.replaceTargets(body));
      if(route==='/api/ui-deliveries'){
        try{return reply(200,await (['recover-image','recover-file'].includes(body.operation)?deliveryControls.recoverImage(body):deliveryControls.change(body)));}
        catch(error){throw fault(/STOP_REQUIRED/.test(error.code??'')?'请先停止机器人，并手动清空微信输入框后再确认恢复。':/VERSION_CONFLICT/.test(error.code??'')?'任务状态已变化，请刷新后重试。':/RECOVERY_REQUIRED/.test(error.code??'')?'这条消息需要先检查微信中的草稿或发送结果，不能继续发送；取消不会清除微信草稿。':/ACCOUNT/.test(error.code??'')?'当前微信账号已变化，请刷新队列。':'这条任务暂时无法调整，请刷新发送队列。',409);}
      }
      if(route==='/api/bot-controls/voice/save')return reply(200,await robot.saveVoice(body));
      if(route==='/api/bot-controls/voice/select')return reply(200,await robot.selectVoice(body));
      if(route==='/api/bot-controls/media/import')return reply(200,await robot.importReplyMedia(body));
      if(route==='/api/bot-controls/media/save')return reply(200,await robot.saveReplyMedia(body));
      if(route==='/api/bot-controls/interaction')return reply(200,await robot.replaceInteraction(body));
      if(route==='/api/bot-controls/uia-mode')return reply(200,await robot.replaceUiaMode(body));
      if(route==='/api/bot-controls/uia-offscreen')return reply(200,await robot.replaceUiaOffscreen(body));
      if(route==='/api/bot-controls/reply')return reply(200,await robot.replaceReply(body));
      if(route==='/api/plugins/inspect')return reply(200,pluginInstaller.inspect(body));
      if(route==='/api/plugins/install')return reply(200,pluginInstaller.install(body));
      if(route==='/api/plugins/cancel')return reply(200,pluginInstaller.cancel(body.ticket));
      const pluginRoute=/^\/api\/plugins\/([a-z][a-z0-9-]{0,39})(\/uninstall)?$/.exec(route);
      if(pluginRoute){const result=pluginRoute[2]?archivePlugin(root,pluginRoute[1],body.revision):updatePlugin(root,pluginRoute[1],body);return reply(200,{ok:true,revision:result.revision});}
      const pluginAction=/^\/api\/plugins\/([a-z][a-z0-9-]{0,39})\/actions\/([a-z][a-z0-9-]{0,19})$/.exec(route);
      if(pluginAction){if(!allowedConversation(chatPolicy(snapshot().config),body.key))throw fault('请选择已允许的聊天。',403);return reply(200,await plugin('/plugin-actions/'+pluginAction[1]+'/'+pluginAction[2],{conversationKey:body.key,args:body.args??{}}));}
      if(route==='/api/fish-notebook/settings'||route==='/api/fish-notebook/write'){
        const previous=snapshot(),params=new URLSearchParams({scope:String(body.scope??''),...(body.key?{conversationKey:body.key}:{})}),current=fishNotebookSnapshot(root,previous,params);
        if(!current.available||!body.scope)throw fault('请先连接微信并刷新记事本。',409);
        if(route==='/api/fish-notebook/write'){if(!current.effectiveEnabled)throw fault('请先安装并为此聊天启用鱼的记事本插件。');const result=await plugin('/fish-notebook/write',{conversationKey:current.conversationKey});if(!result.ok)throw fault('日记暂未写成，请确认 DSH 已加载新版插件宿主后重试。',503);return reply(200,{ok:true});}
        throw fault('鱼的记事本已改为可选插件，请在插件配置中设置开关、时间和聊天范围。',410);
      }
      if(['/api/sticker-manager/import','/api/sticker-manager/edit','/api/sticker-manager/delete'].includes(route))return reply(200,await stickerManager('/'+route.split('/').at(-1),body));
      if(/^\/api\/session-groups\/(create|rename|delete|move)$/.test(route))return reply(200,await plugin(route.slice('/api'.length),body));
      if(route==='/api/group-bindings'){
        const config=snapshot();
        if(body.revision!==config.revision)throw fault('配置已变化，请刷新后重新关联群聊。',409);
        if(!allowedConversation(chatPolicy(config.config),'wechat:group:'+String(body.id))||typeof body.groupRef!=='string'||!/^[A-Za-z0-9_.-]{1,200}@chatroom$/.test(body.groupRef))throw fault('请选择已保存的原会话和当前微信中的群聊。');
        const io=readJson(path.join(root,'state/wechat-io-config.json'));
        const response=await fetchImpl('http://127.0.0.1:'+config.config.ports.weflow+'/api/v1/group-bindings',{method:'POST',headers:{Authorization:'Bearer '+io.reader_token,'Content-Type':'application/json'},body:JSON.stringify({username:body.groupRef,conversationId:String(body.id)}),signal:AbortSignal.timeout(8000)});
        const value=await response.json();
        if(!response.ok){const text=value.error==='GROUP_BINDING_ALREADY_ASSIGNED'?'原会话已绑定另一个真实群，请勿把不同群的历史合并。':value.error==='GROUP_BINDING_ALREADY_SELECTED'?'该群已添加到其他聊天，请先核对聊天范围中的重复项。':'群资料尚未准备好，请在匹配微信中打开该群，再刷新搜索。';throw fault(text,409);}
        statusTime=0;return reply(200,{ok:true,id:String(body.id),name:value.displayName});
      }
      if(['/api/assistant-task/status','/api/assistant-task/cancel','/api/assistant-task/list'].includes(route))return reply(200,await plugin(route.slice(4),{conversationKey:body.key,taskId:body.taskId,localControl:true}));
      if (route === '/api/chat-settings') {
        const previous = snapshot();
        if (body.revision !== previous.revision) throw fault('配置已变化，请重新打开此会话设置。', 409);
        if (!allowedConversation(chatPolicy(previous.config), body.key)) throw fault('只能设置已保存到聊天范围的会话。');
        const config = structuredClone(previous.config);
        applyChatSettings(config, body.key, body.settings, body.access);
        validateConsoleConfig(config, root);
        const workModeChanged=conversationWorkMode(chatPolicy(previous.config),body.key)!==conversationWorkMode(chatPolicy(config),body.key);
        if(workModeChanged){
          const local=buffered().buffer;
          if(local.pendingReplies?.[body.key]||local.pendingRequests?.[body.key])throw fault('此会话还有待处理的回复，请完成当前任务后再切换模式。',409);
          // Offline configuration remains possible; a connected busy session must finish first.
          try{const sessions=await plugin('/sessions'),session=sessions.sessions.find(item=>item.conversationKey===body.key);if(session?.running)throw fault('此会话正在执行，请等待完成或取消任务后再切换模式。',409);}catch(error){if(error.status===409)throw error;}
        }
        const personaChanged = (previous.config.persona.chats?.[body.key] ?? null) !== (config.persona.chats?.[body.key] ?? null);
        backup(configFile); atomic(configFile, config);
        if (personaChanged) markPending();
        statusTime = 0;
        let modeReady=false;
        if(workModeChanged)try{await plugin('/configure',{conversationKey:body.key,workMode:conversationWorkMode(chatPolicy(config),body.key)});modeReady=true;}catch{}
        return reply(200, { ...snapshot(), ...optionalJson(preferenceFile), personaChanged,workModeChanged,modeReady });
      }
      if(route==='/api/dsh-access'){const previous=snapshot();if(body.revision!==previous.revision)throw fault('配置已变化，请重新打开此聊天设置。',409);if(!allowedConversation(chatPolicy(previous.config),body.key))throw fault('只能为已允许的聊天分配技能。');const config=structuredClone(previous.config);config.wechat.dshAccess??={chats:{}};config.wechat.dshAccess.chats[body.key]={skills:body.skills,tools:body.tools};validateConversationSettings(config.wechat);backup(configFile);atomic(configFile,config);statusTime=0;return reply(200,{...snapshot(),pendingApply:false});}
      if(route==='/api/extensions/meme-search')throw fault('表情素材工具由 DSH 项目插件提供，请在 DSH 授权页分配到聊天。',410);
      const builtinRoute=/^\/api\/extensions\/(native-member-memory|dsh-meme|native-web-reader|native-search|native-stickers|native-proactive|native-context)$/.exec(route);
      if(builtinRoute) {
        if(fs.existsSync(path.join(root,'state/reader-service/selection.json'))){
          const selected=await targetView();
          if(selected?.error||!selected?.accountRef||body.accountRef!==selected.accountRef||body.selectionVersion!==selected.version)
            throw fault('微信账号或聊天名单已变化，请重新打开扩展设置。',409);
        }
        const previous=snapshot();
        if(body.revision!==previous.revision)throw fault('配置已变化，请重新打开扩展设置。',409);
        const chatKeys=allowedKeys({wechat:chatPolicy(previous.config)});
        let config;try{config=validateConsoleConfig(applyBuiltinUpdate(previous.config,builtinRoute[1],body,{chatKeys}),root);}catch(error){throw error.status?error:fault(error.message);}
        backup(configFile);atomic(configFile,config);
        return reply(200,{...snapshot(),...optionalJson(preferenceFile)});
      }
      if (route === '/api/reader-accounts') {
        if (typeof body.dbPath !== 'string' || body.dbPath.length > 4096 || /[\0\r\n]/.test(body.dbPath)) throw fault('目录包含无效字符。');
        protectingCredential = true;
        try {
          const python = optionalJson(path.join(root, 'state/ui-runtime.json')).pythonBase;
          if (!python) throw fault('请先完成本机 DSH 运行环境配置。');
          const result = await readerSetup({ root, python, request: { operation: 'discover', dbPath: body.dbPath.trim() } });
          if (!result.ok) throw fault(readerSetupMessage(result.code));
          return reply(200, { accounts: result.accounts });
        } catch (error) { throw error.status ? error : fault(readerSetupMessage(error.message)); }
        finally { protectingCredential = false; }
      }
      if (route === '/api/quit') {
        try{await robot.close?.();}catch{throw fault('语音服务尚未确认停止，控制台保持打开。请检查运行状态后重试。',503);}
        reply(200, { ok: true });
        setTimeout(() => { if (onQuit) onQuit(); else { server.closeAllConnections(); server.close(); } }, 100);
        return;
      }
      if (route === '/api/config') {
        const previous = snapshot();
        if (body.revision !== previous.revision) throw fault('配置已在其他窗口更新，请重新载入后再保存。', 409);
        const config = validateConsoleConfig(body.config, root);
        if (Object.values(config.ports).includes(boundPort)) throw fault('服务端口不能与当前控制台端口重复。');
        syncInstalledUiRuntime(root,config);
        backup(configFile); atomic(configFile, config);
        const restartSettings = value => {
          const copy = structuredClone(value);
          for (const key of ['fishNotebook','replyLayout','stickers','search','webReader','proactive','context','chatModes','dshAccess','memeLibrary','assistant']) delete copy.wechat[key];
          return JSON.stringify(copy);
        };
        if(restartSettings(previous.config)!==restartSettings(config))markPending(JSON.stringify(previous.config.dsh) !== JSON.stringify(config.dsh) || previous.config.ports.dshPlugin !== config.ports.dshPlugin);
        return reply(200, { ...snapshot(), ...optionalJson(preferenceFile) });
      }
      if(route==='/api/assistant-feedback')return reply(200,saveFeedback(root,body));
      if (route === '/api/persona-categories') return reply(200,personaCategories.update(body));
      if (route === '/api/roles/delete') {
        if(personaError(body.name,'check'))throw fault('请选择有效的人设卡，不能删除说明文件或文件路径。');
        if(body.confirmed!==true)throw fault('请先确认删除人设卡。',409);
        const directory=path.join(root,'roles');
        if(!fs.existsSync(directory))throw fault('人设卡已不存在，请刷新后重试。',404);
        if(fs.lstatSync(directory).isSymbolicLink())throw fault('人设目录为链接，不能通过此入口删除。');
        const filename=fs.readdirSync(directory).find(name=>name.toLocaleLowerCase()===(body.name+'.md').toLocaleLowerCase());
        if(!filename)throw fault('人设卡已不存在，请刷新后重试。',404);
        const name=filename.slice(0,-3),file=path.join(directory,filename),stat=fs.lstatSync(file);
        if(!stat.isFile()||stat.isSymbolicLink())throw fault('此人设不是普通文件，不能删除。');
        if(body.revision!==hash(fs.readFileSync(file,'utf8')))throw fault('人设卡已被修改，请重新载入后再删除。',409);
        const references=personaReferences(snapshot().config.persona,name,snapshot().config.wechat.modeSettings);
        if(references.default)throw fault('此人设是默认人设，请先切换默认人设并保存设置。',409);
        if(references.chats.length)throw fault('有聊天正在使用此人设，请先切换聊天人设并保存设置。',409);
        backup(file);
        const marker=deletedPersonaFile(name),previous=fs.existsSync(marker)?fs.readFileSync(marker,'utf8'):null;
        atomic(marker,{version:1,name});
        let restoreCategories;
        try{restoreCategories=personaCategories.forget(name);fs.unlinkSync(file);}catch(error){restoreCategories?.();if(previous===null)fs.unlinkSync(marker);else atomic(marker,previous);throw error;}
        return reply(200,{ok:true,name});
      }
      if (route === '/api/roles') {
        const error = personaError(body.name, body.content);
        if (error) throw fault(error);
        fs.mkdirSync(path.join(root, 'roles'), { recursive: true });
        const file = path.join(root, 'roles', body.name + '.md');
        const exists = fs.existsSync(file);
        if (exists && body.revision !== hash(fs.readFileSync(file, 'utf8'))) throw fault('同名人格已存在或已被修改，请重新载入或换一个名称。', 409);
        if (!exists && body.revision) throw fault('人格文件已被移动，请重新载入。', 409);
        backup(file); atomic(file, body.content);
        const marker=deletedPersonaFile(body.name);if(fs.existsSync(marker))fs.unlinkSync(marker);
        markPending();
        return reply(200, { ok: true, revision: hash(body.content), categories: categorySnapshot() });
      }
      if (route === '/api/browse') {
        if (!['exe', 'folder', 'workspace'].includes(body.kind)) throw fault('无效的文件类型。');
        if(choosingFile)throw fault('文件选择窗口已打开，请先完成或取消当前选择。',409);
        choosingFile=true;
        try{return reply(200, { path: filePicker ? await filePicker(body.kind) : await nativeHelper(body.kind) });}
        finally{choosingFile=false;}
      }
      if (route === '/api/dsh-reopened') {
        const health=await plugin('/health');
        if(!dshConfigurationMatches(root,snapshot().config,health))throw fault('DSH 尚未加载当前模型或插件版本，请准备配置并完整重开 DSH。',409);
        atomic(preferenceFile, { ...optionalJson(preferenceFile), dshRestartRequired: false }); statusTime = 0;
        return reply(200, { ok: true });
      }
      if(route==='/api/process-recovery/prepare')return reply(200,await processRecovery.prepare(body.scanId,body.ids,snapshot().revision));
      if(route==='/api/process-recovery/stop'){
        if(['state/ui-service.lock','state/native-voice-outbox/worker.lock','state/native-voice-attempts/active.json','state/voice-preview/timed/active.json'].some(relative=>fs.existsSync(path.join(root,relative))))throw fault('界面或语音操作尚未确认结束。请使用“停止服务”等待清理，不能通过进程修复强制结束。',409);
        processRecoveryBusy=true;
        try{return reply(200,await processRecovery.stop(body.confirmation,body.confirmed,snapshot().revision));}
        finally{processRecoveryBusy=false;statusTime=0;}
      }
      if (route === '/api/reader-config') throw fault('请使用“连接并验证微信”保存读取配置。',409);
      throw fault('接口不存在。', 404);
    } catch (error) {
      const message = error.code === 'ENOENT' ? '所需文件尚未准备，请检查连接设置。' : error.status ? error.message : '操作失败，请检查配置和本机文件。';
      reply(error.status ?? 500, { error: safeText(message) });
    }
  });
  server.requestTimeout = 360000;
  const start=()=>new Promise((resolve,reject)=>{
    let attempts=0;
    const listen=()=>{
      attempts++;
      const ready=()=>{server.removeListener('error',failed);resolve(server.address());};
      const failed=error=>{server.removeListener('listening',ready);if(port===0&&attempts<16&&['EADDRINUSE','EACCES'].includes(error.code)){listen();return;}reject(error);};
      server.once('error',failed);
      server.once('listening',ready);
      // Windows port 0 can choose a browser-blocked service port (e.g. 6667).
      server.listen(port===0?crypto.randomInt(20000,60000):port,'127.0.0.1');
    };
    listen();
  });
  server.on('close',()=>{pluginInstaller.dispose();Promise.resolve(robot.close?.()).catch(()=>{});});
  return { server, shutdown, isBusy: () => shuttingDown || !!activeJob || protectingCredential || processRecoveryBusy || choosingFile, close: () => { server.closeAllConnections(); server.close(); }, start };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.WECHATAGENT_CONSOLE_PORT ?? 3210);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid console port');
  const app = createConsole({ port });
  await app.start();
  console.log(`WeChatAgent Console: http://127.0.0.1:${port}`);
}
