import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { checkLocalReader } from './reader-local-setup.mjs';
import { activeReaderAccount, readerAccountId } from './reader-account-state.mjs';
import { TargetSelectionStore } from './target-selection.mjs';
import { startTargetReader } from './reader-target-service.mjs';
import { validateConfig } from './project-config.mjs';
import { createUiReaderMediaProxy } from './ui-reader-media-proxy.mjs';
import { createManagedVoiceService } from './managed-voice-service.mjs';
import { UiaModeStore,inspectUiaMode } from './uia-mode.mjs';
import { createUiaModeRuntime } from './uia-mode-runtime.mjs';
import { recoverUiaOffscreenWindow,createUiaOffscreenManager,consumeOffscreenNoMoveRefusal } from './uia-offscreen.mjs';
import { UiaOffscreenStore } from './uia-offscreen-mode.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const fault = code => Object.assign(new Error(code), { code });
const safeCode = error => /^(?:UI|UIA_MODE|UIA_OFFSCREEN|OFFSCREEN|READER|VOICE|QT|DRAFT|CONTACT_IDENTITY|NATIVE_VOICE)_[A-Z0-9_]{1,70}$/.test(error?.code ?? '') ? error.code : 'UI_SERVICE_FAILED';
function noLinks(file) {
  for (let current = path.resolve(file);; current = path.dirname(current)) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('UI_SERVICE_LINK_REFUSED');
    if (path.dirname(current) === current) return path.resolve(file);
  }
}
function read(file, max = 1024 * 1024) {
  noLinks(file); const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > max) throw fault('UI_SERVICE_CONFIG_REQUIRED');
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { throw fault('UI_SERVICE_CONFIG_INVALID'); }
}

/** Disk settings contain no Reader token. The receive-only sidecar supplies the
 * exact account and current private token only to the in-process UI bridge. */
export function readUiServiceSettings({ root = projectRoot, check = checkLocalReader } = {}) {
  if(fs.existsSync(noLinks(path.join(root,'state/reader-service/recovery-transaction.json'))))throw fault('UI_RECOVERY_INCOMPLETE');
  const config = validateConfig(read(path.join(root, 'config/wechatagent.json')));
  if (config.runtime.sender !== 'wechat-ui') throw fault('UI_SERVICE_BACKEND_REQUIRED');
  const binding = check({ root });
  const active = activeReaderAccount(root);
  const reader = read(path.join(root, 'state/weflow/WeFlow-config.json'));
  if (!binding.cached || active.id !== binding.account.accountRef || readerAccountId(root, reader) !== binding.account.accountRef) throw fault('UI_SERVICE_ACCOUNT_NOT_ACTIVATED');
  const settingsFile = config.ui?.bridgeConfig ?? path.join(root, 'state/ui-bridge/config.json');
  const settings = read(settingsFile, 65536);
  if (settings.version !== 1 || typeof settings.hostConfig !== 'string' || !path.isAbsolute(settings.hostConfig) || /^[\\/]{2}/u.test(settings.hostConfig) ||
      typeof settings.enableInput !== 'boolean' || typeof settings.allowSubmit !== 'boolean' || settings.allowSubmit && !settings.enableInput ||
      (settings.allowClipboardReplacement !== undefined && typeof settings.allowClipboardReplacement !== 'boolean') ||
      ['reader','token','accountWxid','accountDirectory','selectionFile','targets','onebotUrl'].some(key => Object.hasOwn(settings, key))) throw fault('UI_SERVICE_CONFIG_INVALID');
  noLinks(settings.hostConfig);
  if (!fs.statSync(settings.hostConfig, { throwIfNoEntry: false })?.isFile()) throw fault('UI_BINDING_REQUIRED');
  return { config, settings, settingsFile, accountRef: binding.account.accountRef };
}

/** One Reader generation per selection version. Never restart an old generation
 * until its bridge and Reader have both settled; cleanup uncertainty is fatal. */
export async function runUiService({ root = projectRoot, signal, load = readUiServiceSettings,
  createStore = input => new TargetSelectionStore(input), startReader = startTargetReader,
  runBridge = async options => (await import('./ui-onebot.mjs')).runUiBridge(options), createVoiceService = createManagedVoiceService,
  createUiaRuntime=createUiaModeRuntime,createUiaStore=input=>new UiaModeStore(input),inspectUia=inspectUiaMode,recoverOffscreen=recoverUiaOffscreenWindow,
  createOffscreenStore=input=>new UiaOffscreenStore(input),createOffscreenManager=createUiaOffscreenManager,readHostConfig=file=>read(file,131072),
  onState = () => {}, onReader = () => {}, onSenderControl=()=>{},onOffscreenControl=()=>{},onVoiceControl=()=>{},pollMs = 250 } = {}) {
  if (!Number.isInteger(pollMs) || pollMs < 10 || pollMs > 5000) throw fault('UI_SERVICE_OPTIONS_INVALID');
  let initial, store;
  try { initial = load({ root }); store = createStore({ root, accountRef: initial.accountRef }); }
  catch (error) { throw Object.assign(error, { cleanupConfirmed: true }); }
  const voiceService = createVoiceService({ root });
  let voiceState={phase:'idle'},lastReport={},offscreenManager;
  const report = state => {lastReport={...lastReport,...state};onState({ backend:'wechat-ui',...lastReport,voiceService:voiceState });};
  const releaseVoiceControl=onVoiceControl(async request=>{
    if(signal?.aborted)throw fault('VOICE_SERVICE_ABORTED');
    if(voiceState.phase==='loading')throw fault('VOICE_OPERATION_BUSY');
    voiceState={phase:'loading'};report({});
    try{
      const selected=await voiceService.useProfile(request);
      voiceState={phase:selected.applied?'ready':'idle'};return selected;
    }catch(error){voiceState={phase:'failed',code:safeCode(error)};throw error;}
    finally{report({});}
  });
  try {
  await recoverOffscreen({root,signal});
  const uiaStore=createUiaStore({root}),offscreenStore=createOffscreenStore({root});
  const applyOffscreen=async(enabled,operationSignal)=>{
    if(!enabled&&!offscreenManager)return{state:'restored',restored:true,released:true,parked:false,windowMoved:false,inputSent:false};
    offscreenManager??=createOffscreenManager({root});
    return offscreenManager.setEnabled({enabled,...(enabled?{config:readHostConfig(initial.settings.hostConfig)}:{}),signal:operationSignal});
  };
  while (!signal?.aborted) {
    const selected = store.get(), generation = new AbortController();
    let reader, bridgeTask, timer, releaseReader, releaseControl, releaseOffscreenControl, activeSender, senderFailure, modeTransition,changed = false, switching=false;
    let failSender;const senderDone=new Promise((_,reject)=>{failSender=reject;});senderDone.catch(()=>{});
    const abort = () => generation.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let failure;
    try {
      report({ ready: false, reader_connected: false, ob_connected: false, phase: 'starting' });
      reader = await startReader({ root, selectionFile: store.file, port: initial.config.ports.weflow, signal: generation.signal });
      const runtimeConfig = () => {
        const latest = load({ root });
        if (latest.accountRef !== initial.accountRef || latest.settingsFile !== initial.settingsFile || JSON.stringify(latest.config.ports) !== JSON.stringify(initial.config.ports) || latest.settings.hostConfig !== initial.settings.hostConfig) throw fault('UI_SERVICE_CONFIG_CHANGED');
        return { ...latest.settings, accountWxid: reader.accountWxid, accountDirectory: reader.accountDirectory,
          onebotUrl: `ws://127.0.0.1:${initial.config.ports.onebot}/ws`, selectionFile: store.file, selectionVersion: selected.version,
          targets: selected.targets.map(target => ({ ...target, kind: target.wxid.endsWith('@chatroom') ? 'group' : 'private' })),
          reader: { baseUrl: reader.baseUrl, token: reader.token, initialCursor: reader.initialCursor } };
      };
      releaseReader = onReader({ reader, accountRef: initial.accountRef, selectionVersion: selected.version, targets: selected.targets,
        signal: generation.signal, validateCurrent: () => {
          runtimeConfig();
          if (JSON.stringify(store.get()) !== JSON.stringify(selected)) throw fault('UI_MEDIA_SCOPE_REVOKED');
          if (generation.signal.aborted || reader.signal?.aborted) throw fault('UI_MEDIA_GENERATION_REVOKED');
        } });
      const launchSender=async enabled=>{
        const sender={enabled,controller:new AbortController(),stopping:false,uiaRuntime:null};activeSender=sender;
        if(enabled){sender.uiaRuntime=createUiaRuntime({root,accountWxid:reader.accountWxid,accountDirectory:reader.accountDirectory,selectionStore:store,hostConfig:initial.settings.hostConfig});
          const started=await sender.uiaRuntime.start({signal:generation.signal});if(started?.ready!==true)throw fault('UIA_MODE_NOT_READY');}
        sender.task=Promise.resolve().then(()=>runBridge({root,config:runtimeConfig(),readConfig:runtimeConfig,signal:sender.controller.signal,voiceService,
          uiaMode:enabled,onSenderSwitchCheck:check=>{sender.switchCheck=check;},onState:state=>report({...state,senderMode:enabled?'uia':'wechat-ui',phase:'running',ready:state.ob_connected===true&&state.reader_connected===true})}));
        bridgeTask=sender.task;
        sender.task.then(()=>{if(!sender.stopping&&!generation.signal.aborted)failSender(fault('UI_SERVICE_UNEXPECTED_EXIT'));},error=>{if(!sender.stopping&&!generation.signal.aborted)failSender(error);});
      };
      const stopSender=async requireSwitchSafe=>{
        const sender=activeSender;if(!sender)return;
        sender.stopping=true;sender.controller.abort();let result,error;
        try{result=await sender.task;}catch(value){error=value;result=value;}
        if(error&&/CLEANUP_UNCONFIRMED|RECORDING_POSSIBLE|STOP_UNCONFIRMED/.test(error.code??''))throw error;
        await sender.uiaRuntime?.close();
        // Keep the stopped sender's read-only queue check if an input raced
        // the preflight. A later explicit switch can recheck manual recovery;
        // it must never restart or retry that delivery automatically.
        if(requireSwitchSafe&&(sender.switchCheck?sender.switchCheck()!==true:result?.senderSwitchSafe!==true))throw fault('UIA_MODE_PENDING_DELIVERY');
        activeSender=null;
        if(error&&!['READER_TARGET_CANCELLED','READER_TARGET_SELECTION_CHANGED','READER_TARGET_START_CANCELLED','UI_BRIDGE_ABORTED','UI_BACKEND_STOPPED','UI_STREAM_CANCELLED','UI_RECEIPT_ABORTED','UI_ONEBOT_DISCONNECTED','UI_QT_CANCELLED','UI_QT_CLOSED','NATIVE_VOICE_ABORTED'].includes(error.code)&&error.name!=='AbortError')throw error;
      };
      let selectedMode=uiaStore.get(),selectedOffscreen=offscreenStore.get();
      if(selectedOffscreen.enabled){
        if(selectedMode.enabled)await applyOffscreen(true,generation.signal);
        else selectedOffscreen=offscreenStore.replace({expectedVersion:selectedOffscreen.version,enabled:false});
      }
      await launchSender(selectedMode.enabled);
      const switchSender=async request=>{
        if(switching||generation.signal.aborted||senderFailure)throw fault('UIA_MODE_BUSY');
        const current=uiaStore.get();
        if(!request||request.backend!=='uia'||Object.keys(request).some(key=>!['expectedVersion','enabled','backend'].includes(key))||typeof request.enabled!=='boolean'||!Number.isSafeInteger(request.expectedVersion)||request.expectedVersion<0)throw fault('UIA_MODE_SETTINGS_INVALID');
        if(request.expectedVersion!==current.version)throw fault('UIA_MODE_VERSION_CONFLICT');
        if(request.enabled){const support=inspectUia({root});if(!support.canEnable)throw fault(support.reason??'UIA_MODE_UNAVAILABLE');}
        if(activeSender?.switchCheck&&activeSender.switchCheck()!==true)throw fault('UIA_MODE_PENDING_DELIVERY');
        switching=true;report({ready:false,phase:'switching-sender'});
        try{
          await stopSender(true);
          // Activate the exact-build accessibility gate and verify a real UIA
          // tree before committing the selection. The Reader stays connected.
          if(request.enabled){const sender={enabled:true,controller:new AbortController(),stopping:false,uiaRuntime:createUiaRuntime({root,accountWxid:reader.accountWxid,accountDirectory:reader.accountDirectory,selectionStore:store,hostConfig:initial.settings.hostConfig})};activeSender=sender;
            const started=await sender.uiaRuntime.start({signal:generation.signal});if(started?.ready!==true)throw fault('UIA_MODE_NOT_READY');
            if(generation.signal.aborted)throw fault('UIA_MODE_ABORTED');
            selectedMode=uiaStore.replace({expectedVersion:request.expectedVersion,enabled:request.enabled});
            sender.task=Promise.resolve().then(()=>runBridge({root,config:runtimeConfig(),readConfig:runtimeConfig,signal:sender.controller.signal,voiceService,uiaMode:true,
              onSenderSwitchCheck:check=>{sender.switchCheck=check;},onState:state=>report({...state,senderMode:'uia',phase:'running',ready:state.ob_connected===true&&state.reader_connected===true})}));
            bridgeTask=sender.task;sender.task.then(()=>{if(!sender.stopping&&!generation.signal.aborted)failSender(fault('UI_SERVICE_UNEXPECTED_EXIT'));},error=>{if(!sender.stopping&&!generation.signal.aborted)failSender(error);});
          }else{
            await applyOffscreen(false,generation.signal);
            if(selectedOffscreen.enabled)selectedOffscreen=offscreenStore.replace({expectedVersion:selectedOffscreen.version,enabled:false});
            selectedMode=uiaStore.replace({expectedVersion:request.expectedVersion,enabled:request.enabled});await launchSender(false);
          }
          // Observe synchronous startup failures and rejected startup promises
          // before acknowledging an active sender. Network readiness continues
          // to be reported separately by the bridge's connection state.
          await Promise.race([activeSender.task.then(()=>{throw fault('UI_SERVICE_UNEXPECTED_EXIT');}),new Promise(resolve=>setImmediate(resolve))]);
          if(generation.signal.aborted||activeSender.controller.signal.aborted)throw fault('UIA_MODE_ABORTED');
          return {...selectedMode,backend:'uia',runtimeActive:true,servicesStarted:true,senderMode:request.enabled?'uia':'wechat-ui',moduleMayRemainLoaded:false,accessibilityMayRemainEnabled:true};
        }catch(error){
          if(activeSender&&!activeSender.task){try{await activeSender.uiaRuntime?.close();activeSender=null;}catch(cleanup){error=cleanup;}}
          if(error?.code!=='UIA_MODE_PENDING_DELIVERY')senderFailure=error;
          report({ready:false,phase:'sender-blocked',reason:safeCode(error)});throw error;
        }
        finally{switching=false;}
      };
      releaseControl=onSenderControl(request=>{
        if(modeTransition)return Promise.reject(fault('UIA_MODE_BUSY'));
        const task=switchSender(request);modeTransition=task;
        return task.finally(()=>{if(modeTransition===task)modeTransition=undefined;});
      });
      const switchOffscreen=async request=>{
        if(switching||generation.signal.aborted||senderFailure)throw fault('UIA_OFFSCREEN_BUSY');
        if(!request||request.backend!=='uia-offscreen'||Object.keys(request).length!==3||typeof request.enabled!=='boolean'||!Number.isSafeInteger(request.expectedVersion)||request.expectedVersion<0)throw fault('UIA_OFFSCREEN_SETTINGS_INVALID');
        const current=offscreenStore.get();if(request.expectedVersion!==current.version)throw fault('UIA_OFFSCREEN_VERSION_CONFLICT');
        if(request.enabled&&!selectedMode.enabled)throw fault('UIA_OFFSCREEN_UIA_REQUIRED');
        if(activeSender?.switchCheck&&activeSender.switchCheck()!==true)throw fault('UIA_OFFSCREEN_PENDING_DELIVERY');
        switching=true;report({ready:false,phase:'switching-offscreen'});
        try{
          await stopSender(true);
          const windowState=await applyOffscreen(request.enabled,generation.signal);
          if(generation.signal.aborted)throw fault('UIA_OFFSCREEN_ABORTED');
          selectedOffscreen=offscreenStore.replace({expectedVersion:request.expectedVersion,enabled:request.enabled});
          await launchSender(selectedMode.enabled);
          await Promise.race([activeSender.task.then(()=>{throw fault('UI_SERVICE_UNEXPECTED_EXIT');}),new Promise(resolve=>setImmediate(resolve))]);
          if(generation.signal.aborted||activeSender.controller.signal.aborted)throw fault('UIA_OFFSCREEN_ABORTED');
          return{...selectedOffscreen,backend:'uia-offscreen',runtimeActive:true,windowState};
        }catch(error){
          if(error?.code==='UIA_MODE_PENDING_DELIVERY')throw fault('UIA_OFFSCREEN_PENDING_DELIVERY');
          if(request.enabled&&!current.enabled&&!activeSender&&!generation.signal.aborted&&offscreenStore.get().version===current.version&&uiaStore.get().version===selectedMode.version&&consumeOffscreenNoMoveRefusal(error)){
            let resumed=false;
            try{
              await launchSender(selectedMode.enabled);
              await Promise.race([activeSender.task.then(()=>{throw fault('UI_SERVICE_UNEXPECTED_EXIT');}),new Promise(resolve=>setImmediate(resolve))]);
              if(generation.signal.aborted||activeSender.controller.signal.aborted)throw fault('UIA_OFFSCREEN_ABORTED');
              resumed=true;
            }catch(restartError){error=restartError;}
            // No window action or message input occurred. Restore the prior
            // sender, but report the refused toggle and leave its setting off.
            // There is no repeat of the parking command or any delivery input.
            if(resumed)throw error;
          }
          senderFailure=error;report({ready:false,phase:'sender-blocked',reason:safeCode(error)});failSender(error);throw error;
        }finally{switching=false;}
      };
      releaseOffscreenControl=onOffscreenControl(request=>{
        if(modeTransition)return Promise.reject(fault('UIA_OFFSCREEN_BUSY'));
        const task=switchOffscreen(request);modeTransition=task;return task.finally(()=>{if(modeTransition===task)modeTransition=undefined;});
      });
      timer = setInterval(() => {
        try { if (store.get().version !== selected.version) { changed = true; generation.abort(); }else if(!switching&&uiaStore.get().version!==selectedMode.version){generation.abort();failSender(fault('UIA_MODE_STATE_CHANGED'));}else if(!switching&&offscreenStore.get().version!==selectedOffscreen.version){generation.abort();failSender(fault('UIA_OFFSCREEN_STATE_CHANGED'));} }
        catch { generation.abort(); }
      }, pollMs);
      await Promise.race([reader.done,senderDone,new Promise(resolve=>generation.signal.addEventListener('abort',resolve,{once:true}))]);
      if (!signal?.aborted && !changed) {
        changed = store.get().version !== selected.version;
        if (!changed) throw fault('UI_SERVICE_UNEXPECTED_EXIT');
      }
    } catch (error) {
      failure = error;
      if (error?.code === 'READER_TARGET_SELECTION_CHANGED') changed = true;
    } finally {
      clearInterval(timer);releaseControl?.();releaseOffscreenControl?.(); releaseReader?.(); generation.abort(); signal?.removeEventListener('abort', abort);if(activeSender){activeSender.stopping=true;activeSender.controller.abort();}
      try{await modeTransition;}catch(error){if(/CLEANUP_UNCONFIRMED|RECORDING_POSSIBLE|STOP_UNCONFIRMED/.test(error?.code??''))failure=error;}
      report({ ready: false, reader_connected: false, ob_connected: false, phase: signal?.aborted ? 'stopping' : 'switching' });
      const cleanup = await Promise.allSettled([bridgeTask, reader?.stop()]);
      if(activeSender?.uiaRuntime){try{await activeSender.uiaRuntime.close();}catch(error){cleanup.push({status:'rejected',reason:error});}}
      for (const result of cleanup) if (result.status === 'rejected' && /CLEANUP_UNCONFIRMED|RECORDING_POSSIBLE|STOP_UNCONFIRMED/.test(result.reason?.code ?? '')) failure = result.reason;
      if (failure?.code === 'READER_TARGET_CLEANUP_UNCONFIRMED') throw failure;
      if (failure && /CLEANUP_UNCONFIRMED|RECORDING_POSSIBLE|STOP_UNCONFIRMED/.test(failure.code ?? '')) throw failure;
      if (changed) for (const result of cleanup) if (result.status === 'rejected' && result.reason?.name !== 'AbortError' &&
          !['READER_TARGET_CANCELLED','READER_TARGET_SELECTION_CHANGED','READER_TARGET_START_CANCELLED','UI_BRIDGE_ABORTED',
            'UI_BACKEND_STOPPED','UI_STREAM_CANCELLED','UI_RECEIPT_ABORTED','UI_ONEBOT_DISCONNECTED','UI_QT_CANCELLED','UI_QT_CLOSED','NATIVE_VOICE_ABORTED'].includes(result.reason?.code)) throw result.reason;
    }
    if (signal?.aborted) break;
    if (!changed) throw Object.assign(failure ?? fault('UI_SERVICE_UNEXPECTED_EXIT'), { cleanupConfirmed: true });
  }
  } finally {
    // Bridge cleanup has drained synthesis and the native recording transport.
    // Selection changes share the model; only stopping this host releases it.
    releaseVoiceControl?.();
    try{await voiceService.close();}finally{await offscreenManager?.close();}
  }
  report({ ready: false, reader_connected: false, ob_connected: false, phase: 'stopped' });
  return { stopped: true };
}

export async function startUiServiceHost({ root = projectRoot, signal, run = runUiService } = {}) {
  const initial = readUiServiceSettings({ root });
  const lockFile = noLinks(path.join(root, 'state/ui-service.lock')), lease = crypto.randomUUID();
  try { fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, lease }), { flag: 'wx', mode: 0o600 }); }
  catch { throw fault('UI_SERVICE_BUSY'); }
  const tokenFile = noLinks(path.join(root, 'state/social-dsh-token.txt'));
  let token, server, task, media, senderControl,offscreenControl,voiceControl,clean = false;
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let state = { ready: false, ob_connected: false, reader_connected: false, phase: 'starting' };
  try {
    token = fs.readFileSync(tokenFile, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw fault('UI_SERVICE_TOKEN_REQUIRED');
    media = createUiReaderMediaProxy({ token, getPort: () => initial.config.ports.adapter });
    server = http.createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json');
      const validHost = req.headers.host === `127.0.0.1:${initial.config.ports.adapter}`;
      if (!validHost || req.headers.origin !== undefined) { res.writeHead(403).end('{}'); return; }
      if (await media.handle(req, res)) return;
      if (req.method === 'GET' && req.url === '/status') {
        res.end(JSON.stringify({ project: 'WeChatAgent', component: 'adapter', statusVersion: 1, backend: 'wechat-ui', pid: process.pid,
          projectRoot: root, ...state })); return;
      }
      if (req.method === 'POST' && req.url === '/shutdown' && req.headers.authorization === 'Bearer ' + token) {
        controller.abort(); res.end('{"stopping":true}'); return;
      }
      if(req.method==='POST'&&['/sender-mode','/sender-offscreen','/voice-profile/select'].includes(req.url)){
        if(req.headers.authorization!=='Bearer '+token){res.writeHead(401).end('{}');return;}
        const offscreen=req.url==='/sender-offscreen',voice=req.url==='/voice-profile/select',handler=voice?voiceControl:offscreen?offscreenControl:senderControl;
        try{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>4096)throw fault(voice?'VOICE_PROFILE_INVALID':offscreen?'UIA_OFFSCREEN_SETTINGS_INVALID':'UIA_MODE_SETTINGS_INVALID');chunks.push(chunk);}
          const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!handler)throw fault(voice?'VOICE_SERVICE_UNAVAILABLE':offscreen?'UIA_OFFSCREEN_SERVICE_REQUIRED':'UIA_MODE_SERVICE_NOT_READY');
          const value=await handler(body);res.end(JSON.stringify(value));
        }catch(error){res.writeHead(409).end(JSON.stringify({error:safeCode(error)}));}return;
      }
      res.writeHead(404).end('{}');
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(initial.config.ports.adapter, '127.0.0.1', resolve); });
    if (signal?.aborted) controller.abort();
    task = run({ root, signal: controller.signal, onState: update => { state = update; }, onReader: binding => media.publish(binding),
      onSenderControl:handler=>{senderControl=handler;return()=>{if(senderControl===handler)senderControl=undefined;};},
      onOffscreenControl:handler=>{offscreenControl=handler;return()=>{if(offscreenControl===handler)offscreenControl=undefined;};},
      onVoiceControl:handler=>{voiceControl=handler;return()=>{if(voiceControl===handler)voiceControl=undefined;};} });
    try { await task; clean = true; } catch (error) { clean = error?.cleanupConfirmed === true; throw error; }
  } finally {
    media?.close(); controller.abort(); signal?.removeEventListener('abort', abort);
    if (server) await new Promise(resolve => server.close(resolve));
    // A cleanly failed setup can be retried. An uncertain native/Reader cleanup
    // must retain the lease for deliberate recovery, never guess from a PID.
    if (clean || !task) {
      noLinks(lockFile);
      if (JSON.parse(fs.readFileSync(lockFile, 'utf8')).lease === lease) fs.unlinkSync(lockFile);
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(async () => {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--check') {
      readUiServiceSettings();
      console.log(JSON.stringify({ configurationValid: true, liveUiVerified: false, automaticReplies: false, inputSent: false })); return;
    }
    if (args.length) throw fault('UI_SERVICE_ARGUMENTS_INVALID');
    const controller = new AbortController();
    for (const event of ['SIGINT','SIGTERM']) process.once(event, () => controller.abort());
    await startUiServiceHost({ signal: controller.signal });
  }).catch(error => {
    console.error(safeCode(error));
    if(typeof error.nativeAction==='string'&&/^[a-zA-Z]{1,48}$/.test(error.nativeAction)){
      const details={nativeAction:error.nativeAction};
      for(const name of ['attempted','clipboardRestored','cleanupConfirmed','controlsCleanupFailed'])
        if(typeof error[name]==='boolean')details[name]=error[name];
      const outcome=error.focusRestoreOutcome;
      if(outcome){
        details.focusRestore={};
        for(const name of ['restored','skipped'])
          if(typeof outcome[name]==='boolean')details.focusRestore[name]=outcome[name];
        if(typeof outcome.stage==='string'&&/^[a-z-]{1,48}$/.test(outcome.stage))details.focusRestore.stage=outcome.stage;
      }
      console.error(JSON.stringify(details));
    }
    process.exitCode = 1;
  });
}
