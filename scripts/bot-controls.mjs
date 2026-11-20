import path from 'node:path';
import fs from 'node:fs';
import {checkLocalReader} from './reader-local-setup.mjs';
import {readSelectableContacts,initializeSelectionDirectory} from './reader-target-service.mjs';
import {TargetSelectionStore} from './target-selection.mjs';
import {VoiceProfileStore} from './voice-profiles.mjs';
import {InteractionPolicyStore,currentUiCapabilities,resolveInteractionPlan} from './runtime-interaction-policy.mjs';
import {ReplyPreferences} from './reply-preferences.mjs';
import {readForegroundTimings} from './foreground-timing.mjs';
import {UiaModeStore,inspectUiaMode,requestUiaSenderMode} from './uia-mode.mjs';
import {UiaOffscreenStore,requestUiaOffscreenMode} from './uia-offscreen-mode.mjs';
import {applyStoppedOffscreen,uiSettingsServiceRunning,withStoppedUiSettings} from './uia-offscreen.mjs';
import {createManagedVoiceService} from './managed-voice-service.mjs';
import {ReplyMediaCatalog} from './reply-media-catalog.mjs';

const failure=(message,status=400)=>Object.assign(new Error(message),{status});
export function botControlsError(error) {
  const code=String(error?.code??'');
  if(code==='SPEECH_PROVIDER_SETTINGS_INVALID')return failure(error.message,error.status);
  if(/VERSION_CONFLICT|REVISION_CONFLICT/.test(code))return failure('设置已被其他页面修改，请刷新后重新选择。',409);
  if(/ACCOUNT_CHANGED|ACCOUNT_REQUIRED|ACCOUNT_MISMATCH/.test(code))return failure('当前微信账号已变化，请重新连接账号并刷新此页。',409);
  if(/BACKGROUND_SEND_UNAVAILABLE/.test(code))return failure('当前通过微信界面发送，需要保留本机键鼠操作保护。',409);
  if(code==='UIA_MODE_SERVICE_REQUIRED')return failure('机器人服务正在启动或退出，请稍后再试。',409);
  if(code==='UIA_MODE_PENDING_DELIVERY')return failure('有已输入的草稿、待确认发送或录音需要处理。请先在发送队列中核对并完成恢复，再切换 UIA 模式；尚未输入的排队消息会保留。',409);
  if(code==='UIA_MODE_BUSY')return failure('发送方式正在切换，或上次切换失败后通道尚未恢复。请查看服务状态，处理提示后重试。',409);
  if(code==='UIA_OFFSCREEN_SERVICE_REQUIRED')return failure('机器人服务正在启动或退出，请稍后再试。',409);
  if(code==='UIA_OFFSCREEN_UIA_REQUIRED')return failure('请先开启 UIA 模式，再使用离屏开关；关闭离屏不会关闭 UIA。',409);
  if(code==='UIA_OFFSCREEN_PENDING_DELIVERY')return failure('当前有草稿、发送或录音尚未完成，请先在发送队列中处理，再移动微信窗口。',409);
  if(code==='UIA_OFFSCREEN_BUSY')return failure('微信窗口位置正在切换，请稍后再试。',409);
  if(/^(?:UIA_OFFSCREEN_|OFFSCREEN_)/.test(code))return failure('微信窗口位置尚未确认，请检查微信与机器人服务状态后重试。',409);
  if(/^UIA_MODE_/.test(code))return failure('UIA 模式暂不可切换，请核对匹配微信、控件与文字、图片、语音组件及服务状态。',409);
  if(code==='FOCUS_HANDOFF_UNAVAILABLE')return failure('当前发送组件尚不支持焦点归还，请先更新本机发送组件。',409);
  if(code==='INTERACTION_POLICY_INVALID')return failure('电脑使用方式无效，请重新选择发送方式并保留操作保护。',400);
  if(/BUSY|LOCKED|UNKNOWN/.test(code))return failure('当前操作尚未完成或状态待确认，请查看运行状态后重试。',409);
  if(/^VOICE_/.test(code))return failure('语音方案未保存或切换失败。请核对模型目录、权重文件、参考音频和方案名称。',400);
  if(/^REPLY_MEDIA_/.test(code))return failure('素材未能保存。请选择本机 PNG、JPEG 或 GIF，检查文件是否仍在原位置；每张不超过 20 MB、4096 像素边长和 400 万像素，GIF 最多 200 帧且累计画布不超过 8000 万像素。',400);
  if(/CONTACT_UNVERIFIED|CATALOG_INVALID|PROTOCOL_INVALID/.test(code))return failure('所选好友或群聊未能唯一核对，请刷新列表后重新选择；同名群聊请先修改群备注。',409);
  if(/TARGET_SELECTION_REQUEST_INVALID/.test(code))return failure('请选择最多 32 个好友或群聊，同一对象不能重复。',400);
  if(code==='UI_REPLY_SETTINGS_INVALID')return failure('回复方式设置无效，请选择模拟输入文字或原生微信语音；已有配置异常时需先修复本机设置。',400);
  if(/^READER_|^UI_TARGET_SELECTION_/.test(code))return failure('本机微信读取配置尚未就绪或账号需要重新核对，请先完成本机连接。',503);
  return failure('无法读取或保存机器人设置，请检查本机配置。',500);
}
const targetView=value=>({version:value.version,accountRef:value.accountRef,automaticReplies:false,targets:value.targets.map(({wxid,id,label,alias})=>({wxid,id,label,alias}))});
const voiceView=value=>({...value,statusText:value.status==='unknown'?'上次加载结果未确认，请重启语音服务后使用此方案。':value.applied===true?'所选方案已加载。':'本地方案尚未加载。'});

async function selectRobotVoice(root, request) {
  const config=JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8').replace(/^\uFEFF/,''));
  const port=config?.ports?.adapter;
  const token=fs.readFileSync(path.join(root,'state/social-dsh-token.txt'),'utf8').trim();
  if(!Number.isInteger(port)||port<1024||port>65535||!/^[a-f0-9]{64}$/.test(token))throw Object.assign(Error(),{code:'VOICE_SERVICE_UNAVAILABLE'});
  const base=`http://127.0.0.1:${port}`;
  const status=await fetch(base+'/status',{redirect:'error',signal:AbortSignal.timeout(2500)}).then(r=>r.ok?r.json():null);
  if(status?.backend!=='wechat-ui'||status.project!=='WeChatAgent'||typeof status.projectRoot!=='string'||path.relative(root,status.projectRoot)!=='')
    throw Object.assign(Error(),{code:'VOICE_SERVICE_UNAVAILABLE'});
  const response=await fetch(base+'/voice-profile/select',{
    method:'POST',redirect:'error',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify(request),signal:AbortSignal.timeout(600000),
  });
  const value=await response.json();
  if(!response.ok||value?.selectedId!==request.id||!Array.isArray(value.profiles)||typeof value.applied!=='boolean')
    throw Object.assign(Error(),{code:/^VOICE_[A-Z_]{1,80}$/.test(value?.error)?value.error:'VOICE_SERVICE_UNAVAILABLE'});
  return value;
}

/** Settings and explicit window control; this service never sends replies. */
export function createBotControls({root=path.resolve(import.meta.dirname,'..'),check=checkLocalReader,
  contacts=readSelectableContacts,initialize=initializeSelectionDirectory,TargetStore=TargetSelectionStore,VoiceStore=VoiceProfileStore,PolicyStore=InteractionPolicyStore,ReplyStore=ReplyPreferences,useVoiceProfile,
  UiaStore=UiaModeStore,inspectUia=inspectUiaMode,requestUia=requestUiaSenderMode,OffscreenStore=UiaOffscreenStore,requestOffscreen=requestUiaOffscreenMode,moveStoppedWindow=applyStoppedOffscreen}={}) {
  let managedVoice,closing=false;const voiceTasks=new Set();
  const loadVoice=useVoiceProfile??(async request=>{
    if(uiSettingsServiceRunning(root))return selectRobotVoice(root,request);
    managedVoice??=createManagedVoiceService({root,createProfiles:()=>new VoiceStore({root})});
    return managedVoice.useProfile(request);
  });
  // Construct lazily so a missing reader/model install does not break the console.
  const targetStore=async accountRef=>{
    const current=check({root}).account.accountRef;
    if(accountRef!==undefined&&accountRef!==current)throw Object.assign(new Error('READER_TARGET_ACCOUNT_CHANGED'),{code:'READER_TARGET_ACCOUNT_CHANGED'});
    try{return new TargetStore({root,accountRef:current});}catch(error){
      if(error.code!=='UI_TARGET_SELECTION_NOT_INITIALIZED')throw error;
      await initialize({root,expectedAccountRef:current,check});
      return new TargetStore({root,accountRef:current});
    }
  };
  const voices=()=>new VoiceStore({root});
  const policy=()=>new PolicyStore({root});
  const uia=()=>new UiaStore({root});
  const offscreen=()=>new OffscreenStore({root});
  const uiaView=(runtimeActive=uiSettingsServiceRunning(root))=>{
    const support=inspectUia({root});
    return {...support,...uia().get(),runtimeActive,canEnable:!runtimeActive||support.canEnable};
  };
  const offscreenView=(mode=uiaView())=>{const saved=offscreen().get();return {...saved,canEnable:mode.enabled&&mode.canEnable,canChange:mode.enabled||saved.enabled};};
  const policyView=value=>{
    const text=resolveInteractionPlan({policy:{pauseOnHumanActivity:false},capabilities:currentUiCapabilities,operation:'sendText'});
    const voice=resolveInteractionPlan({policy:{pauseOnHumanActivity:false},capabilities:currentUiCapabilities,operation:'sendNativeVoice'});
    const handoff=resolveInteractionPlan({policy:{pauseOnHumanActivity:true,sendMode:'focus-handoff'},capabilities:currentUiCapabilities,operation:'sendNativeVoice'});
    const mode=uiaView();
    return {...value,ocrTextEntryMode:value.textEntryMode,textEntryMode:mode.enabled?'paste':value.textEntryMode,canDisablePause:text.allowed&&voice.allowed,canUseFocusHandoff:handoff.allowed,uiaMode:mode,offscreenMode:offscreenView(mode),foregroundTiming:readForegroundTimings({root}),
      focusHandoffVerified:currentUiCapabilities.focusHandoff?.sendNativeVoice?.verified===true,focusHandoffProductionReady:handoff.productionReady,
      statusText:mode.enabled
        ?'已选择 UIA 快速链路：通过微信控件定位，文字快速输入；文字、图片与语音沿用发送回执核验。需要前台时借用焦点，结束后归还；语音录音期间返回原窗口，用户输入保护继续生效。'
        :'已选择 OCR 快速链路：识屏定位并快速搜索联系人，文字正文'+(value.textEntryMode==='humanized'?'逐字输入':'快速粘贴')+'；语音在开始和发送时借用焦点、录音期间返回原窗口。文字和语音均通过微信界面发送，结束后归还焦点；操作键鼠时暂停输入，发送后确认回执。'};
  };
  async function guarded(action){try{return await action();}catch(error){throw botControlsError(error);}}
  function voiceAction(action){
    const task=guarded(async()=>{if(closing)throw Object.assign(new Error(),{code:'VOICE_SERVICE_ABORTED'});return action();});
    voiceTasks.add(task);task.finally(()=>voiceTasks.delete(task)).catch(()=>{});return task;
  }
  function validateOfflineSwitch(store, body, prefix) {
    const invalid=code=>Object.assign(new Error(code),{code});
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==2||typeof body.enabled!=='boolean'||!Number.isSafeInteger(body.expectedVersion)||body.expectedVersion<0)throw invalid(prefix+'_SETTINGS_INVALID');
    const current=store.get();
    if(current.version!==body.expectedVersion)throw invalid(prefix+'_VERSION_CONFLICT');
    if(current.version===Number.MAX_SAFE_INTEGER)throw invalid(prefix+'_STATE_INVALID');
  }
  function replaceUiaMode(body){return guarded(async()=>{
    if(uiSettingsServiceRunning(root)){
      const saved=await requestUia({root,request:body});return {...inspectUia({root}),...saved};
    }
    const store=uia(),validate=()=>validateOfflineSwitch(store,body,'UIA_MODE');
    const save=()=>{
      const saved=store.replace(body,{deferVerification:true});
      return {...saved,runtimeActive:false,canEnable:true};
    };
    if(body?.enabled===false){
      return moveStoppedWindow({root,enabled:false,validate,apply:()=>{
        const screen=offscreen(),current=screen.get();
        const result=save();
        if(current.enabled)screen.replace({expectedVersion:current.version,enabled:false});
        return result;
      }});
    }
    return withStoppedUiSettings(root,()=>{validate();return save();});
  });}
  function replaceUiaOffscreen(body){return guarded(async()=>{
    if(uiSettingsServiceRunning(root)){
      const mode=uiaView(true);
      if(body?.enabled===true&&!mode.enabled)throw Object.assign(new Error('UIA_OFFSCREEN_UIA_REQUIRED'),{code:'UIA_OFFSCREEN_UIA_REQUIRED'});
      const saved=await requestOffscreen({root,request:body});
      return {...saved,canEnable:mode.enabled&&mode.canEnable,canChange:mode.enabled||saved.enabled};
    }
    const store=offscreen();
    const validate=()=>{
      validateOfflineSwitch(store,body,'UIA_OFFSCREEN');
      if(body.enabled&&!uia().get().enabled)throw Object.assign(new Error('UIA_OFFSCREEN_UIA_REQUIRED'),{code:'UIA_OFFSCREEN_UIA_REQUIRED'});
    };
    validate();
    return moveStoppedWindow({root,enabled:body.enabled,validate,apply:windowState=>{
      const saved=store.replace(body),allowed=uia().get().enabled;
      return {...saved,backend:'uia-offscreen',runtimeActive:false,windowState,canEnable:allowed,canChange:allowed||saved.enabled};
    }});
  });}
  const interaction=()=>guarded(()=>policyView(policy().get()));
  const voice=()=>guarded(async()=>voiceView(await voices().snapshot()));
  return {
    interaction,voice,
    async snapshot(){
      const results=await Promise.allSettled([guarded(async()=>targetView((await targetStore()).get())),voice(),interaction(),Promise.resolve({mode:'automatic'}),guarded(()=>new ReplyMediaCatalog({root}).snapshot())]);
      return {notice:'设置更新不会自动启用回复；离屏开关会立即调整微信窗口位置。正在运行的机器人会使用保存后的回复对象。',
        ...Object.fromEntries(['targets','voice','interaction','reply','replyMedia'].map((key,index)=>[key,results[index].status==='fulfilled'?results[index].value:{error:results[index].reason.message}]))};
    },
    targets(){return guarded(async()=>targetView((await targetStore()).get()));},
    contacts({accountRef,keyword=''}){return guarded(async()=>{if(typeof accountRef!=='string')throw Object.assign(new Error(),{code:'READER_TARGET_ACCOUNT_REQUIRED'});const store=await targetStore(accountRef);return contacts({root,expectedAccountRef:store.accountRef,keyword,limit:100});});},
    replaceTargets(body){return guarded(async()=>{if(typeof body.accountRef!=='string')throw Object.assign(new Error(),{code:'READER_TARGET_ACCOUNT_REQUIRED'});const store=await targetStore(body.accountRef);const saved=await store.replace({expectedVersion:body.expectedVersion,targetWxids:body.targetWxids});await targetStore(body.accountRef);return targetView(saved);});},
    saveSpeechSelection(providers,voice){
      return voiceAction(async()=>{
        const result=await voices().saveSpeechSelection(providers,voice);
        return {...result,voice:voiceView(result.voice)};
      });
    },
    saveVoice(body){return voiceAction(async()=>voiceView(await voices().save({expectedVersion:body.expectedVersion,id:body.id,name:body.name,config:body.config})));},
    selectVoice(body){return voiceAction(async()=>voiceView(await loadVoice({expectedVersion:body.expectedVersion,id:body.id})));},
    async close(){closing=true;await Promise.allSettled([...voiceTasks]);return managedVoice?.close();},
    voiceFiles(){return guarded(()=>voices().discover());},
    importReplyMedia(body){return guarded(()=>new ReplyMediaCatalog({root}).importDirectory({directory:body.directory,kind:body.kind,expectedRevision:body.expectedRevision}));},
    saveReplyMedia(body){return guarded(()=>new ReplyMediaCatalog({root}).replace(body));},
    replaceUiaMode,
    replaceUiaOffscreen,
    replaceInteraction(body){return guarded(()=>{if(uia().get().enabled)throw Object.assign(new Error('UIA_MODE_EXCLUSIVE'),{code:'UIA_MODE_EXCLUSIVE'});return policyView(policy().replace({expectedVersion:body.expectedVersion,pauseOnHumanActivity:body.pauseOnHumanActivity,
      ...(Object.hasOwn(body,'sendMode')?{sendMode:body.sendMode}:{}),...(Object.hasOwn(body,'textEntryMode')?{textEntryMode:body.textEntryMode}:{})}));});},
    replaceReply(){throw failure('回复形式由机器人按本轮内容自动选择，不再支持固定文字或语音。',409);},
  };
}
