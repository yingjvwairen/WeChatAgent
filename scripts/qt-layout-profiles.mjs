import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import { validateQtConfig, createQtVisualDriver, toObservedPopupCalibration } from './qt-visual-driver.mjs';

const fault = code => Object.assign(new Error(code), { code, attempted: false, waitable: true });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function noLinks(file) { for (let at=path.resolve(file);;at=path.dirname(at)) { if(fs.lstatSync(at,{throwIfNoEntry:false})?.isSymbolicLink())throw fault('UI_QT_PROFILE_LINK_REFUSED');if(path.dirname(at)===at)return; } }
function read(file,optional=false) { noLinks(file);const stat=fs.statSync(file,{throwIfNoEntry:false});if(!stat&&optional)return null;if(!stat?.isFile()||stat.size>131072)throw fault('UI_QT_PROFILE_INVALID');try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{throw fault('UI_QT_PROFILE_INVALID');} }
const normalizedExecutable = value => path.resolve(value).replaceAll('\\','/').toLowerCase();
export function qtLayoutIdentity(config) {
  const value=validateQtConfig(config);
  return {accountRef:value.accountRef,executable:normalizedExecutable(value.executable),executableVersion:value.executableVersion,
    executableSha256:value.executableSha256,width:value.layout.width,height:value.layout.height,dpi:value.layout.dpi};
}
const keyFor=identity=>hash(JSON.stringify(identity));
const directoryFor=root=>path.join(root,'state/ui-runtime/qt-layout-profiles');
function sameIdentity(left,right){return JSON.stringify(left)===JSON.stringify(right);}

/** Explicit calibration saves only; resolver candidates never enter this store. */
export function saveQtLayoutProfile({root,config,now=Date.now}={}) {
  const valid=validateQtConfig(config),identity=qtLayoutIdentity(valid),key=keyFor(identity),directory=directoryFor(root),file=path.join(directory,key+'.json');
  noLinks(directory);fs.mkdirSync(directory,{recursive:true,mode:0o700});noLinks(file);
  const savedAt=now();if(!Number.isSafeInteger(savedAt)||savedAt<=0)throw fault('UI_QT_PROFILE_INVALID');
  const value={version:1,key,identity,config:valid,savedAt},temporary=file+'.'+crypto.randomUUID()+'.tmp';
  try{fs.writeFileSync(temporary,JSON.stringify(value),{flag:'wx',mode:0o600});noLinks(file);fs.renameSync(temporary,file);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  return {key,file};
}

export function inspectedQtLayoutIdentity(config,inspection) {
  const binding=inspection?.binding,area=binding?.clientRect;
  if(!object(inspection)||inspection.version!==1||inspection.readOnly!==true||inspection.inputSent!==false||inspection.focusChanged!==false||inspection.clipboardAccessed!==false||
      !object(binding)||!Number.isSafeInteger(binding.pid)||binding.pid<1||!/^[1-9][0-9]{0,19}$/.test(binding.hwnd??'')||!/^[1-9][0-9]{0,19}$/.test(binding.processCreatedFileTimeUtc??'')||
      !object(area)||area.left!==0||area.top!==0||!Number.isSafeInteger(area.right)||!Number.isSafeInteger(area.bottom)||area.right<600||area.bottom<400||area.right>4096||area.bottom>4096||area.right*area.bottom>12000000||
      !Number.isSafeInteger(binding.dpi)||binding.dpi<48||binding.dpi>768||!digest(inspection.executableSha256)||!/^\d+(\.\d+){3}$/.test(inspection.executableVersion??''))throw fault('UI_QT_LAYOUT_INSPECTION_INVALID');
  return {...qtLayoutIdentity(config),executableVersion:inspection.executableVersion,executableSha256:inspection.executableSha256,width:area.right,height:area.bottom,dpi:binding.dpi};
}

export function selectQtLayoutProfile({root,currentConfig,inspection}={}) {
  const current=validateQtConfig(currentConfig),identity=inspectedQtLayoutIdentity(current,inspection),key=keyFor(identity);
  if(sameIdentity(qtLayoutIdentity(current),identity))return {config:current,key,source:'current'};
  const value=read(path.join(directoryFor(root),key+'.json'),true);
  if(!value)return null;
  if(value.version!==1||value.key!==key||!sameIdentity(value.identity,identity)||!sameIdentity(qtLayoutIdentity(value.config),identity))throw fault('UI_QT_PROFILE_INVALID');
  // Window handles are ephemeral; exact geometry, executable and account remain
  // bound. The selected driver reacquires and verifies the current process.
  return {config:{...validateQtConfig(value.config),hwnd:'auto'},key,source:'saved'};
}

/** Only program/account-bound popup identity is portable between layouts.
 * Conflicting saved identities fail closed; window coordinates never escape. */
export function resolveQtPopupIdentities({root,config,convert=toObservedPopupCalibration,searchOnly=false}={}){
  const base=qtLayoutIdentity(config),candidates=[config],directory=directoryFor(root);noLinks(directory);
  const names=fs.existsSync(directory)?fs.readdirSync(directory):[];
  if(names.length>256)throw fault('UI_QT_PROFILE_INVALID');
  for(const name of names){
    if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
    const value=read(path.join(directory,name)),identity=value?.identity;
    if(!object(identity)||!['accountRef','executable','executableVersion','executableSha256'].every(key=>identity[key]===base[key]))continue;
    if(value.version!==1||value.key!==name.slice(0,-5)||keyFor(identity)!==value.key||!sameIdentity(qtLayoutIdentity(value.config),identity))throw fault('UI_QT_PROFILE_INVALID');
    candidates.push(value.config);
  }
  const fields=searchOnly?[['searchPopupCalibration','search']]:[['selfSurface','profile'],['profileSurface','profile'],['searchPopupCalibration','search']],result={};
  for(const [field,kind] of fields){
    let identity;
    for(const candidate of candidates){
      const value=field==='searchPopupCalibration'?candidate[field]:candidate[field]?.popupCalibration;if(value===undefined)continue;
      const next=convert(value,kind);
      if(identity!==undefined&&!sameIdentity(identity,next))throw fault('UI_QT_POPUP_IDENTITY_CONFLICT');identity=next;
    }
    if(identity===undefined)throw fault('UI_QT_POPUP_CALIBRATION_REQUIRED');
    result[field]=field==='searchPopupCalibration'?identity:{popupCalibration:identity};
  }
  return result;
}

/** UIA replaces layout-dependent calibration only. Identity, preferences and
 * executable integrity remain those of the caller's validated configuration. */
export function toUiaLayoutConfig(config,{layout,voice,searchPopupCalibration}={}){
  const next=structuredClone(config);
  next.layoutMode='uia-v1';next.focusActivationMode='uia-caption-v1';
  next.layout=Object.fromEntries(['width','height','dpi','search','header','editor','send'].map(key=>[key,structuredClone(layout[key])]));
  for(const key of ['selfSurface','profileSurface','selfCloseKey','profileCloseKey','focusActivation'])delete next[key];
  next.searchPopupCalibration=structuredClone(searchPopupCalibration);
  next.voice={recordStartRect:structuredClone(voice.recordStartRect),toolbarRect:structuredClone(voice.toolbarRect),recordingUi:{focusHwnd:'same',uia:{version:1,executableVersion:config.executableVersion}}};
  return next;
}

/** Re-select only at an operation boundary. Geometry checks during the actual
 * input transaction remain the responsibility of the existing Qt driver. */
export function createLayoutAwareQtDriver({root=path.resolve(import.meta.dirname,'..'),configFile=path.join(root,'state/ui-runtime/qt-visual.json'),config,
  driverFactory=createQtVisualDriver,resolveUnknownLayout,resolveControls,prepareWindow,...options}={}) {
  if(resolveControls!==undefined&&typeof resolveControls!=='function')throw fault('UI_QT_CONTROLS_RESOLVER_INVALID');
  if(prepareWindow!==undefined&&(typeof prepareWindow!=='function'||options.navigationPolicy!=='uia-controls-v1'))throw fault('UI_QT_WINDOW_PREPARATION_INVALID');
  let driver=driverFactory({root,...options,config:validateQtConfig(config??read(configFile))}),busy=false,closed=false,pending,voiceOwnership;
  const methods=new Set(['prepare','prepareVoiceSession','prepareVoiceHandoff']);
  const active=signal=>{if(closed||signal?.aborted)throw fault('UI_QT_CANCELLED');};
  const occupied=job=>!!(driver.busy||driver.textFocusLease||driver.voiceFocusLease||voiceOwnership||driver.draftHold||driver.current?.draft||driver.textResume?.draft||driver.current?.imageApplied||driver.textResume?.imageApplied||job?.index>0||job?.pendingInput);
  async function select(job,signal,allowFocusCapture){
    active(signal);
    if(prepareWindow&&!occupied(job)){
      await prepareWindow({config:structuredClone(driver.config),signal,releaseInput:async()=>{
        active(signal);if(occupied(job))throw fault('UI_QT_LAYOUT_CHANGED_WITH_DRAFT');
        const current=driver,config=structuredClone(current.config);await current.close();active(signal);
        driver=driverFactory({root,...options,config});
      }});active(signal);
    }
    const inspection=await driver.client.request('inspectLayout');active(signal);
    const identity=inspectedQtLayoutIdentity(driver.config,inspection);
    if(options.navigationPolicy==='uia-controls-v1'){
      if(typeof resolveControls!=='function')throw fault('UI_QT_CONTROLS_RESOLVER_INVALID');
      if(identity.executableVersion!==driver.config.executableVersion||identity.executableSha256!==driver.config.executableSha256)throw fault('UI_QT_CONTROLS_CONFIG_CHANGED');
      if(!sameIdentity(identity,qtLayoutIdentity(driver.config))&&occupied(job))throw fault('UI_QT_LAYOUT_CHANGED_WITH_DRAFT');
      const candidate=await resolveControls({root,config:structuredClone(driver.config),inspection:structuredClone(inspection),signal,client:driver.client});active(signal);
      if(candidate?.verified!==true||candidate.proof!=='uia-controls-v1'||!sameIdentity(qtLayoutIdentity(candidate.config),identity))throw fault('UI_QT_CONTROLS_UNVERIFIED');
      const next=validateQtConfig(candidate.config),popup=resolveQtPopupIdentities({root,config:driver.config,searchOnly:true}).searchPopupCalibration;
      const permitted=toUiaLayoutConfig(driver.config,{layout:next.layout,voice:{recordStartRect:next.voice?.recordStartRect,toolbarRect:next.voice?.toolbarRect},searchPopupCalibration:popup});
      if(!isDeepStrictEqual(next,permitted))throw fault('UI_QT_CONTROLS_CONFIG_CHANGED');
      if(isDeepStrictEqual(next,driver.config))return;
      if(occupied(job))throw fault('UI_QT_LAYOUT_CHANGED_WITH_DRAFT');
      await driver.close();active(signal);driver=driverFactory({root,...options,config:{...next,hwnd:'auto'}});return;
    }
    const missingAdaptiveMetadata=typeof resolveUnknownLayout==='function'&&identity.executableVersion==='4.1.15.56'&&
      (!driver.config.selfSurface?.popupCalibration||!driver.config.profileSurface?.popupCalibration||!driver.config.searchPopupCalibration);
    let selected={config:driver.config};
    if(!sameIdentity(identity,qtLayoutIdentity(driver.config))||missingAdaptiveMetadata){
      if(occupied(job))throw fault('UI_QT_LAYOUT_CHANGED_WITH_DRAFT');
      selected=missingAdaptiveMetadata?null:selectQtLayoutProfile({root,currentConfig:driver.config,inspection});
      if(!selected&&typeof resolveUnknownLayout==='function'){
        const candidate=await resolveUnknownLayout({root,config:structuredClone(driver.config),inspection:structuredClone(inspection),signal,client:driver.client,allowFocusCapture});active(signal);
        if(candidate!==null&&candidate!==undefined){
          if(candidate.verified!==true||candidate.proof!=='verified-edge-anchor-layout-v1'||!sameIdentity(qtLayoutIdentity(candidate.config),identity))throw fault('UI_QT_LAYOUT_RESOLUTION_UNVERIFIED');
          selected={config:validateQtConfig(candidate.config)};
        }
      }
    }
    if(!selected)throw fault('UI_QT_LAYOUT_PROFILE_REQUIRED');
    if(resolveControls){
      // Always refresh actual controls at a preparation boundary, including
      // same-size windows and resumable drafts. A changed overlay must never
      // replace the native owner of a draft or focus lease.
      const candidate=await resolveControls({root,config:structuredClone(selected.config),inspection:structuredClone(inspection),signal});active(signal);
      if(candidate?.verified!==true||candidate.proof!=='uia-controls-v1'||!sameIdentity(qtLayoutIdentity(candidate.config),identity))throw fault('UI_QT_CONTROLS_UNVERIFIED');
      const next=validateQtConfig(candidate.config),permitted=structuredClone(selected.config);
      for(const key of ['search','editor','send','header'])permitted.layout[key]=structuredClone(next.layout[key]);
      if(permitted.voice&&next.voice)permitted.voice.recordStartRect=structuredClone(next.voice.recordStartRect);
      if(permitted.voice?.recordingUi?.adaptive&&next.voice?.recordingUi?.adaptive)permitted.voice.recordingUi.adaptive.toolbarRect=structuredClone(next.voice.recordingUi.adaptive.toolbarRect);
      if(!isDeepStrictEqual(next,permitted))throw fault('UI_QT_CONTROLS_CONFIG_CHANGED');
      selected={config:next};
    }
    if(isDeepStrictEqual(selected.config,driver.config))return;
    active(signal);if(occupied(job))throw fault('UI_QT_LAYOUT_CHANGED_WITH_DRAFT');
    await driver.close();active(signal);
    driver=driverFactory({root,...options,config:{...selected.config,hwnd:'auto'}});
  }
  async function exclusive(action){
    active();if(busy||voiceOwnership)throw fault('UI_QT_BUSY');busy=true;
    let finish;pending=new Promise(resolve=>{finish=resolve;});
    try{return await action();}finally{busy=false;pending=undefined;finish();}
  }
  return new Proxy({}, {get(_target,key){
    if(key==='close')return async()=>{closed=true;return driver.close();};
    if(key==='closed')return closed;
    if(key==='resolveLayout')return (job,request={})=>exclusive(async()=>{
      // Resolve before starting the caller's idle observation. A new layout
      // owns a new helper and therefore a new native activity monitor; never
      // transfer the previous helper's warm-up or input authority to it.
      if(options.navigationPolicy!=='uia-controls-v1')throw fault('UI_QT_CONTROLS_POLICY_INVALID');
      await select(job,request.signal,false);active(request.signal);
      return {resolved:true,layoutMode:'uia-v1'};
    });
    if(key==='finishVoiceInteraction')return ({jobId,cleanupConfirmed}={})=>{
      if(voiceOwnership&&voiceOwnership.jobId===jobId&&cleanupConfirmed===true){voiceOwnership=undefined;return true;}return false;
    };
    if(key==='releaseTextFocus')return async()=>{
      // Cleanup waits for preparation/input to settle; it must never collide
      // with inspectLayout or close a newly acquired/transferred voice lease.
      await pending;if(voiceOwnership)return {released:false,restored:false,skipped:true};
      if(closed)return driver.releaseTextFocus?.();
      return exclusive(()=>driver.releaseTextFocus?.());
    };
    if(methods.has(key))return (job,request={})=>exclusive(async()=>{
      const plan=request.interactionPlan;
      const allowFocusCapture=key==='prepareVoiceHandoff'||plan?.executionMode==='focus-handoff'||plan?.sendMode==='focus-handoff';
      try{await select(job,request.signal,allowFocusCapture);}catch(error){
        active(request.signal);
        // No coordinates or focus lease were acquired. A hidden new layout
        // can wait in the queue; it does not require a manually saved profile.
        // Session callers require a session-or-error contract, never ready:false.
        if(key!=='prepareVoiceSession'&&error?.code==='UI_QT_LAYOUT_WINDOW_OBSCURED'&&error.attempted===false&&error.waitable===true)
          return {ready:false,reason:error.code,attempted:false};
        if(key!=='prepareVoiceSession'&&error?.code==='UI_QT_LAYOUT_FOCUS_OCCLUDED'&&error.focusRestored===true)
          return {ready:false,reason:error.code};
        if(key!=='prepareVoiceSession'&&error?.code==='UI_QT_LAYOUT_VISIBILITY_BLOCKED'&&error.visibilityRestored===true)
          return {ready:false,reason:error.code};
        if(key!=='prepareVoiceSession'&&error?.code==='QT_LAYOUT_SOURCE_ORDER_UNAVAILABLE'&&error.attempted===false)
          return {ready:false,reason:error.code,attempted:false};
        // These capability failures precede lease acquisition. Do not let a
        // missing return caption tear down the Reader; failures carrying any
        // acquisition/cleanup evidence retain their original error contract.
        if(key!=='prepareVoiceSession'&&['QT_RETURN_CAPTION_UNAVAILABLE','QT_RETURN_CAPTION_WARMUP'].includes(error?.code)&&error.attempted===false&&!error.focusRestoreOutcome&&!error.focusConfirmation&&!error.foregroundInterval)
          return {ready:false,reason:error.code==='QT_RETURN_CAPTION_WARMUP'?'QT_ACTIVITY_WARMUP':error.code,attempted:false};
        throw error;
      }
      const result=await driver[key](job,request);
      if(key==='prepareVoiceSession'&&result?.focusHandoff){
        const ownership={jobId:job?.id};voiceOwnership=ownership;
        if(typeof result.releaseFocus==='function'){const release=result.releaseFocus;return {...result,releaseFocus:async()=>{
          const released=await release();if(voiceOwnership===ownership&&(released?.restored===true||released?.skipped===true))voiceOwnership=undefined;return released;
        }};}
      }
      return result;
    });
    // An image resume must retain the original native instance and geometry;
    // selecting/replacing a layout here would discard its in-memory proof.
    if(['observe','typeGrapheme','pasteText','pasteImage','resumeImage','submitImage','submit','readDraft','sendAction'].includes(key))return (...args)=>exclusive(()=>driver[key](...args));
    const value=driver[key];return typeof value==='function'?value.bind(driver):value;
  }});
}
