import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkLocalReader } from './reader-local-setup.mjs';
import { probeAccountBinding } from './account-probe.mjs';
import { QtActionsClient, validateQtConfig } from './qt-visual-driver.mjs';
import { saveQtLayoutProfile } from './qt-layout-profiles.mjs';

const rootDefault=path.resolve(import.meta.dirname,'..');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fault=code=>Object.assign(new Error(code),{code});
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const noLinks=file=>{for(let at=path.resolve(file);;at=path.dirname(at)){if(fs.lstatSync(at,{throwIfNoEntry:false})?.isSymbolicLink())throw fault('UI_QT_CALIBRATION_LINK_REFUSED');if(path.dirname(at)===at)return path.resolve(file);}};
const planKeys=new Set(['layout','accountAlias','ocrBackend','idleMs','settleMs','newlineKey','selfCloseKey','profileCloseKey','selfSurface','profileSurface','searchPopupCalibration']);
const layoutKeys=new Set(['header','search','firstResult','searchResultIdentity','profileOpen','profileMember','profilePanelClose','profileAlias','profileClose','selfOpen','selfAlias','selfClose','editor','send']);
function readSaved(root){const file=noLinks(path.join(root,'state/ui-runtime/qt-visual.json')),info=fs.statSync(file,{throwIfNoEntry:false});if(!info)return{file,bytes:null,config:null};if(!info.isFile()||info.size>65536)throw fault('UI_QT_CONFIG_INVALID');const bytes=fs.readFileSync(file);let config;try{config=validateQtConfig(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')));}catch{throw fault('UI_QT_CONFIG_INVALID');}return{file,bytes,config};}
function saveConfig(previous,config){noLinks(previous.file);const now=fs.existsSync(previous.file)?fs.readFileSync(previous.file):null;if((now===null)!==(previous.bytes===null)||now&&!now.equals(previous.bytes))throw fault('UI_QT_CALIBRATION_CHANGED');const root=path.resolve(path.dirname(previous.file),'../..');if(previous.config)saveQtLayoutProfile({root,config:previous.config});saveQtLayoutProfile({root,config});fs.mkdirSync(path.dirname(previous.file),{recursive:true});const temporary=previous.file+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(temporary,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});fs.renameSync(temporary,previous.file);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}}
function claimCalibration(root){
  const managedFile=noLinks(path.join(root,'state/runtime.json'));if(fs.existsSync(managedFile)){let managed;try{managed=JSON.parse(fs.readFileSync(managedFile,'utf8'));}catch{throw fault('UI_QT_CALIBRATION_STOP_SERVICES');}if(managed.adapter||managed.reader)throw fault('UI_QT_CALIBRATION_STOP_SERVICES');}
  for(const relative of ['state/reader-service/service.lock','state/native-voice-outbox/worker.lock','state/native-voice-attempts/active.json','state/voice-preview/timed/active.json'])if(fs.existsSync(noLinks(path.join(root,relative))))throw fault('UI_QT_CALIBRATION_STOP_SERVICES');
  const file=noLinks(path.join(root,'state/ui-service.lock')),lease=crypto.randomUUID();fs.mkdirSync(path.dirname(file),{recursive:true});let fd;try{fd=fs.openSync(file,'wx',0o600);}catch{throw fault('UI_QT_CALIBRATION_STOP_SERVICES');}try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid,qtCalibrationLease:lease}));}catch(error){fs.closeSync(fd);throw error;}return confirmed=>{fs.closeSync(fd);const current=JSON.parse(fs.readFileSync(noLinks(file),'utf8'));if(confirmed&&current.qtCalibrationLease===lease)fs.unlinkSync(file);};
}
async function finishCapture(client,stopped,releaseLease){let clean=stopped;try{if(!clean){const closed=await client.close();if(closed?.processStopped!==true)throw fault('UI_QT_CLEANUP_UNCONFIRMED');clean=true;}}finally{releaseLease(clean);}}
const voiceBasis=config=>JSON.stringify([config.account,config.accountRef,config.executable,config.executableVersion,config.executableSha256,config.layout.width,config.layout.height,config.layout.dpi,config.layout.editor,config.layout.emptyEditorSha256]);
const focusBasis=config=>JSON.stringify([config.account,config.accountRef,config.executable,config.executableVersion,config.executableSha256,config.layout.width,config.layout.height,config.layout.dpi]);
export function validateQtVoicePlan(plan,config){
  const keys=['recordStartRect','mouseParkRect','cancelRect','submitRect'];
  const rect=r=>object(r)&&Object.keys(r).length===4&&['left','top','right','bottom'].every(k=>Number.isSafeInteger(r[k]))&&r.left>=0&&r.top>=0&&r.right>r.left&&r.bottom>r.top&&r.right<=config.layout.width&&r.bottom<=config.layout.height;
  const size=(r,min,max)=>rect(r)&&r.right-r.left>=min&&r.bottom-r.top>=min&&r.right-r.left<=max&&r.bottom-r.top<=max;
  const overlaps=(a,b)=>a.left<b.right&&b.left<a.right&&a.top<b.bottom&&b.top<a.bottom;
  if(!object(plan)||Object.keys(plan).length!==keys.length||keys.some(k=>!rect(plan[k]))||!size(plan.recordStartRect,4,4096)||!size(plan.mouseParkRect,2,128)||!size(plan.cancelRect,4,128)||!size(plan.submitRect,4,128)||overlaps(plan.cancelRect,plan.submitRect)||[config.layout.editor,plan.recordStartRect,plan.cancelRect,plan.submitRect].some(r=>overlaps(plan.mouseParkRect,r)))throw fault('UI_QT_VOICE_PLAN_INVALID');
  return structuredClone(plan);
}

/** Read-only, project-owned calibration capture. A plan supplies rectangles;
 * process identity, dimensions, DPI, executable version/hash and pixel hash are
 * measured locally. This never types, clicks, opens a chat or claims a blank
 * draft has been verified. The runtime still requires its guarded copy check. */
export async function captureQtCalibration({root=rootDefault,plan,save=false,replace=false,discardVoice=false,background=false,check=checkLocalReader,probeAccount=probeAccountBinding,clientFactory,signal}={}) {
  root=path.resolve(root);
  if(!object(plan)||Object.keys(plan).some(key=>!planKeys.has(key))||!object(plan.layout)||Object.keys(plan.layout).some(key=>!layoutKeys.has(key))||typeof save!=='boolean'||typeof replace!=='boolean'||typeof background!=='boolean'||typeof discardVoice!=='boolean'||discardVoice&&(!save||!replace))throw fault('UI_QT_CALIBRATION_PLAN_INVALID');
  if(signal?.aborted)throw fault('UI_QT_CANCELLED');
  const previous=save?readSaved(root):null;
  if(save&&!replace&&previous.config)throw fault('UI_QT_CALIBRATION_EXISTS');
  const reader=check({root}),executable=reader.request.wechatExecutable,executableSha256=reader.request.wechatExecutableSha256;
  const client=(clientFactory??(options=>new QtActionsClient(options)))({root,config:{executable,executableSha256,hwnd:'auto'},enableInput:false,calibration:true});
  const releaseLease=save?claimCalibration(root):()=>{};
  let stopped=false;
  const abort=()=>{client.close().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
  try {
    const areas=[plan.layout.header,plan.layout.editor,plan.layout.search];
    const frame=await client.request(background?'captureLayout':'capture',{surface:'main',regions:areas,image:true});
    if(background&&(frame?.readOnly!==true||frame.focusChanged!==false||frame.authorizationGranted!==false))throw fault('UI_QT_CALIBRATION_CAPTURE_INVALID');
    if(frame?.pixelFormat!=='rgba-row-major-opaque-v1')throw fault('UI_QT_NATIVE_UPDATE_REQUIRED');
    if(signal?.aborted)throw fault('UI_QT_CANCELLED');
    const binding=frame.binding;
    if(!object(binding)||(background?typeof binding.foreground!=='boolean':binding.foreground!==true)||frame.inputSent!==false||binding.clientRect?.left!==0||binding.clientRect?.top!==0||
        !Array.isArray(frame.regions)||frame.regions.length!==areas.length||frame.regions.some((r,i)=>!['left','top','right','bottom'].every(k=>r.rect?.[k]===areas[i]?.[k])||!/^[a-f0-9]{64}$/.test(r.rgbaSha256??''))||typeof frame.executableVersion!=='string'||!/^\d+(\.\d+){3}$/.test(frame.executableVersion)||
        !object(frame.image)||typeof frame.image.file!=='string')throw fault('UI_QT_CALIBRATION_CAPTURE_INVALID');
    const imageFile=noLinks(frame.image.file),imageDirectory=noLinks(path.join(root,'state/ui-host/qt-frames'));
    if(path.dirname(imageFile)!==imageDirectory||!/^qt-[a-f0-9]{32}\.png$/.test(path.basename(imageFile)))throw fault('UI_QT_CALIBRATION_CAPTURE_INVALID');
    const imageStat=fs.statSync(imageFile);if(!imageStat.isFile()||imageStat.size<33||imageStat.size>16*1024*1024)throw fault('UI_QT_CALIBRATION_CAPTURE_INVALID');
    const image=fs.readFileSync(imageFile);if(hash(image)!==frame.image.sha256||image.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||image.readUInt32BE(16)!==binding.clientRect.right||image.readUInt32BE(20)!==binding.clientRect.bottom)throw fault('UI_QT_CALIBRATION_CAPTURE_INVALID');
    const account=reader.account.myWxid.trim().replace(/_[A-Za-z0-9]{4}$/u,'');
    const config=validateQtConfig({version:1,backend:'qt-visual',executable,executableVersion:frame.executableVersion,executableSha256,hwnd:'auto',account,accountRef:reader.account.accountRef,
      accountAlias:plan.accountAlias??account,ocrBackend:plan.ocrBackend??'rapidocr',idleMs:plan.idleMs??1000,settleMs:plan.settleMs??400,
      layout:{...plan.layout,width:binding.clientRect.right,height:binding.clientRect.bottom,dpi:binding.dpi,emptyEditorSha256:frame.regions[1].rgbaSha256},
      ...Object.fromEntries(['newlineKey','selfCloseKey','profileCloseKey','selfSurface','profileSurface','searchPopupCalibration'].filter(key=>plan[key]!==undefined).map(key=>[key,plan[key]]))});
    const proof=await probeAccount({root,binding,executable,expectedAccountRef:config.accountRef,signal});
    if(proof?.accountRef!==config.accountRef||proof.evidence?.processId!==binding.pid||proof.evidence?.processCreatedFileTimeUtc!==binding.processCreatedFileTimeUtc||proof.evidence?.processOpenedExpectedDatabase!==true)throw fault('UI_QT_ACCOUNT_UNVERIFIED');
    const current=check({root});if(current.account.accountRef!==reader.account.accountRef||current.request.wechatExecutableSha256!==executableSha256)throw fault('UI_QT_ACCOUNT_CHANGED');
    const closed=await client.release();if(closed?.processStopped!==true)throw fault('UI_QT_CLEANUP_UNCONFIRMED');stopped=true;
    if(signal?.aborted)throw fault('UI_QT_CANCELLED');
    let file=null,voicePreserved=false;
    if(save){
      if(previous.config?.layout.focusActivateRect&&focusBasis(previous.config)===focusBasis(config)){config.layout.focusActivateRect=previous.config.layout.focusActivateRect;config.layout.focusActivateRgbaSha256=previous.config.layout.focusActivateRgbaSha256;}
      if(previous.config?.voice&&!discardVoice){if(voiceBasis(previous.config)!==voiceBasis(config))throw fault('UI_QT_VOICE_RECALIBRATION_REQUIRED');config.voice=structuredClone(previous.config.voice);voicePreserved=true;}
      file=previous.file;saveConfig(previous,config);
    }
    return {config,file,image:frame.image,binding,summary:{ok:true,saved:save,readOnly:true,inputSent:false,clipboardAccessed:false,accountCorroborated:true,desktopAccountVerified:false,targetVerified:false,draftVerified:false,automaticReplies:false,
      voicePreserved,voiceDiscarded:!!previous?.config?.voice&&discardVoice,width:config.layout.width,height:config.layout.height,dpi:config.layout.dpi,executableVersion:config.executableVersion,processStopped:true}};
  } finally {signal?.removeEventListener('abort',abort);await finishCapture(client,stopped,releaseLease);}
}

/** The operator keeps a different app foreground and exposes WeChat's blank
 * titlebar. Read only: no raise, activation, click or inactive-template guess. */
export async function captureQtFocusCalibration({root=rootDefault,plan,save=false,replace=false,check=checkLocalReader,probeAccount=probeAccountBinding,clientFactory,signal,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  root=path.resolve(root);if(!object(plan)||Object.keys(plan).length!==1||!object(plan.rect)||typeof save!=='boolean'||typeof replace!=='boolean')throw fault('UI_QT_FOCUS_PLAN_INVALID');
  const previous=readSaved(root),config=previous.config;if(!config)throw fault('UI_QT_CALIBRATION_REQUIRED');
  validateQtConfig({...config,layout:{...config.layout,focusActivateRect:plan.rect,focusActivateRgbaSha256:'0'.repeat(64)}});
  if(save&&config.layout.focusActivateRect&&!replace)throw fault('UI_QT_CALIBRATION_EXISTS');if(signal?.aborted)throw fault('UI_QT_CANCELLED');
  const reader=check({root});if(reader.account.accountRef!==config.accountRef||reader.request.wechatExecutableSha256!==config.executableSha256||path.resolve(reader.request.wechatExecutable).toLowerCase()!==path.resolve(config.executable).toLowerCase())throw fault('UI_QT_ACCOUNT_CHANGED');
  const client=(clientFactory??(options=>new QtActionsClient(options)))({root,config:{executable:config.executable,executableSha256:config.executableSha256,hwnd:'auto'},enableInput:false,calibration:true});
  const releaseLease=save?claimCalibration(root):()=>{};let stopped=false;
  const abort=()=>{client.close().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
  try{
    const request={idleMs:1000,width:config.layout.width,height:config.layout.height,dpi:config.layout.dpi,rect:plan.rect};let observation;
    try{observation=await client.request('inspectFocusActivation',request);}catch(error){if(error?.code!=='QT_ACTIVITY_WARMUP')throw error;await wait(1000);if(signal?.aborted)throw fault('UI_QT_CANCELLED');observation=await client.request('inspectFocusActivation',request);}
    const b=observation?.binding;
    if(signal?.aborted)throw fault('UI_QT_CANCELLED');
    if(observation?.readOnly!==true||observation.inputSent!==false||observation.focusChanged!==false||observation.clipboardAccessed!==false||observation.stableObservations!==2||b?.foreground!==false||b.clientRect?.left!==0||b.clientRect?.top!==0||b.clientRect?.right!==config.layout.width||b.clientRect?.bottom!==config.layout.height||b.dpi!==config.layout.dpi||!['left','top','right','bottom'].every(k=>observation.rect?.[k]===plan.rect[k])||!/^[a-f0-9]{64}$/.test(observation.rgbaSha256??''))throw fault('UI_QT_FOCUS_CAPTURE_INVALID');
    const proof=await probeAccount({root,binding:b,executable:config.executable,expectedAccountRef:config.accountRef,signal});
    if(proof?.accountRef!==config.accountRef||proof.evidence?.processId!==b.pid||proof.evidence?.processCreatedFileTimeUtc!==b.processCreatedFileTimeUtc||proof.evidence?.processOpenedExpectedDatabase!==true)throw fault('UI_QT_ACCOUNT_UNVERIFIED');
    const current=check({root});if(current.account.accountRef!==reader.account.accountRef||current.request.wechatExecutableSha256!==config.executableSha256)throw fault('UI_QT_ACCOUNT_CHANGED');
    const closed=await client.release();if(closed?.processStopped!==true)throw fault('UI_QT_CLEANUP_UNCONFIRMED');stopped=true;if(signal?.aborted)throw fault('UI_QT_CANCELLED');
    const next=validateQtConfig({...config,layout:{...config.layout,focusActivateRect:structuredClone(plan.rect),focusActivateRgbaSha256:observation.rgbaSha256}});if(save)saveConfig(previous,next);
    return{config:next,file:save?previous.file:null,summary:{ok:true,saved:save,readOnly:true,inputSent:false,focusChanged:false,inactiveTemplate:true,stableObservations:2,processStopped:true,liveActivationVerified:false}};
  }finally{signal?.removeEventListener('abort',abort);await finishCapture(client,stopped,releaseLease);}
}

/** The operator presents the recording controls manually. This captures their
 * pixels only; it neither starts/cancels a recording nor proves which chat is
 * open. The operator must cancel promptly after capture. */
export async function captureQtVoiceCalibration({root=rootDefault,plan,save=false,replace=false,check=checkLocalReader,probeAccount=probeAccountBinding,clientFactory,signal}={}){
  root=path.resolve(root);if(typeof save!=='boolean'||typeof replace!=='boolean')throw fault('UI_QT_VOICE_PLAN_INVALID');
  const previous=readSaved(root),config=previous.config;if(!config)throw fault('UI_QT_CALIBRATION_REQUIRED');
  plan=validateQtVoicePlan(plan,config);if(save&&config.voice&&!replace)throw fault('UI_QT_CALIBRATION_EXISTS');if(signal?.aborted)throw fault('UI_QT_CANCELLED');
  const reader=check({root});if(reader.account.accountRef!==config.accountRef||reader.request.wechatExecutableSha256!==config.executableSha256||path.resolve(reader.request.wechatExecutable).toLowerCase()!==path.resolve(config.executable).toLowerCase())throw fault('UI_QT_ACCOUNT_CHANGED');
  const client=(clientFactory??(options=>new QtActionsClient(options)))({root,config:{executable:config.executable,executableSha256:config.executableSha256,hwnd:'auto'},enableInput:false,calibration:true});
  const releaseLease=save?claimCalibration(root):()=>{};let stopped=false;
  const abort=()=>{client.close().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
  try{
    const areas=[plan.cancelRect,plan.submitRect],frame=await client.request('capture',{surface:'main',regions:areas,image:false}),b=frame?.binding;
    if(signal?.aborted)throw fault('UI_QT_CANCELLED');
    if(frame?.pixelFormat!=='rgba-row-major-opaque-v1'||frame.inputSent!==false||frame.executableVersion!==config.executableVersion||b?.foreground!==true||b.clientRect?.left!==0||b.clientRect?.top!==0||b.clientRect?.right!==config.layout.width||b.clientRect?.bottom!==config.layout.height||b.dpi!==config.layout.dpi||!Array.isArray(frame.regions)||frame.regions.length!==2||frame.regions.some((r,i)=>!['left','top','right','bottom'].every(k=>r.rect?.[k]===areas[i][k])||!/^[a-f0-9]{64}$/.test(r.rgbaSha256??'')))throw fault('UI_QT_VOICE_CAPTURE_INVALID');
    const proof=await probeAccount({root,binding:b,executable:config.executable,expectedAccountRef:config.accountRef,signal});
    if(proof?.accountRef!==config.accountRef||proof.evidence?.processId!==b.pid||proof.evidence?.processCreatedFileTimeUtc!==b.processCreatedFileTimeUtc||proof.evidence?.processOpenedExpectedDatabase!==true)throw fault('UI_QT_ACCOUNT_UNVERIFIED');
    const current=check({root});if(current.account.accountRef!==reader.account.accountRef||current.request.wechatExecutableSha256!==config.executableSha256)throw fault('UI_QT_ACCOUNT_CHANGED');
    const closed=await client.release();if(closed?.processStopped!==true)throw fault('UI_QT_CLEANUP_UNCONFIRMED');stopped=true;if(signal?.aborted)throw fault('UI_QT_CANCELLED');
    const voice={recordStartRect:plan.recordStartRect,mouseParkRect:plan.mouseParkRect,recordingUi:{focusHwnd:'same',cancel:{rect:plan.cancelRect,rgbaSha256:frame.regions[0].rgbaSha256},submit:{rect:plan.submitRect,rgbaSha256:frame.regions[1].rgbaSha256}}};
    const next={...config,voice};if(save)saveConfig(previous,next);
    return{config:next,file:save?previous.file:null,summary:{ok:true,saved:save,readOnly:true,inputSent:false,audioStarted:false,recordingStarted:false,recordingCancelled:false,operatorMustCancel:true,recordingUiVerified:false,liveUiVerified:false,automaticReplies:false,processStopped:true}};
  }finally{signal?.removeEventListener('abort',abort);await finishCapture(client,stopped,releaseLease);}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  (async()=>{const args=process.argv.slice(2);if(!args.length||args[0]==='--help'){console.log('只读生成本机Qt布局配置：--plan <绝对JSON路径> [--save] [--replace] [--discard-voice]\n只读采集录音按钮模板：--voice-plan <绝对JSON路径> [--save] [--replace]\n只读采集非前台标题栏模板：--focus-plan <绝对JSON路径> [--save] [--replace]，计划仅含 rect；将其他应用留在前台、微信空白标题栏保持可见。\n窗口布局请先手动打开空草稿聊天；录音模板请只在文件传输助手手动显示录音界面，采集后立即手动取消（微信到时限可能自动发送）。工具不点击、不录音、不取消，也不证明当前聊天或草稿已验证。');return;}
    if(!['--plan','--voice-plan','--focus-plan'].includes(args[0])||!path.isAbsolute(args[1]??'')||args.slice(2).some(arg=>!['--save','--replace','--discard-voice'].includes(arg))||new Set(args).size!==args.length||args.includes('--replace')&&!args.includes('--save')||args.includes('--discard-voice')&&(args[0]!=='--plan'||!args.includes('--save')||!args.includes('--replace')))throw fault('UI_QT_CALIBRATION_ARGUMENTS_INVALID');
    const file=noLinks(args[1]),stat=fs.statSync(file);if(!stat.isFile()||stat.size>32768)throw fault('UI_QT_CALIBRATION_PLAN_INVALID');
    const plan=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));const result=args[0]==='--focus-plan'?await captureQtFocusCalibration({plan,save:args.includes('--save'),replace:args.includes('--replace')}):args[0]==='--voice-plan'?await captureQtVoiceCalibration({plan,save:args.includes('--save'),replace:args.includes('--replace')}):await captureQtCalibration({plan,save:args.includes('--save'),replace:args.includes('--replace'),discardVoice:args.includes('--discard-voice')});
    // Account names, profile OCR and captured pixels stay in private local files.
    console.log(JSON.stringify({...result.summary,configFile:result.file,...(result.image?{imageFile:result.image.file}:{})}));
  })().catch(error=>{console.error(/^(?:UI_QT|UI_ACCOUNT|READER_LOCAL|QT|DRAFT)_[A-Z0-9_]+$/.test(error?.code??'')?error.code:'UI_QT_CALIBRATION_FAILED');process.exitCode=1;});
}
