import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { isDeepStrictEqual } from 'node:util';
import { recognizeImage, warmLocalOcr } from './visual-probe.mjs';
import { contactIdentity } from './contact-identity.mjs';
import { probeAccountBinding, validateAccountEvidence } from './account-probe.mjs';
import { readSelectableContacts } from './reader-target-service.mjs';
import { sanitizeForegroundIntervals, makeForegroundTiming, recordForegroundTiming } from './foreground-timing.mjs';
import { validateVoiceRecordingLayout } from './voice-recording-layout.mjs';

const fault = (code, properties = {}) => Object.assign(new Error(code), { code, ...properties });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pasteCommands = new Set(['paste','pasteImage','pasteUiaFile','pasteUiaImage']);
function clipboardSettled(report, allowReplacement) {
  if (report?.clipboardRestored === true) return report.clipboardReplaced !== true;
  return allowReplacement === true && report?.clipboardRestored === false && report.clipboardReplaced === true;
}
function clipboardOutcome(report) {
  return report.clipboardReplaced === true ? {clipboardRestored:false,clipboardReplaced:true} : {clipboardRestored:true};
}
const preparedTargetLookup=Symbol('qt-prepared-target-lookup');
const observedLayout=config=>config.layoutMode==='adaptive-v1'||config.layoutMode==='uia-v1';
const sharedTargetProof=proof=>['database-query-search-enter-v1','uia-database-title-v1'].includes(proof?.kind);
const uiaTargetEvidence=lookup=>lookup?.uiaTarget?.version===1&&['database-unique-display-name-v1','database-exact-alias-v1'].includes(lookup.uiaTarget.proof)&&/^[a-f0-9]{64}$/.test(lookup.uiaTarget.titleSha256)&&lookup.uiaTarget.querySha256===crypto.createHash('sha256').update(lookup.displayedId).digest('hex');
const sharedVoicePreparation=Symbol('qt-shared-voice-preparation');
const verifiedProfileCloseFailure=Symbol('qt-verified-profile-close-failure');
const navigationTransitionFailure=Symbol('qt-navigation-transition-failure');
const uiaVerificationRefusal=Symbol('qt-uia-verification-refusal');
function markUiaVerificationRefusal(error,operation,{hadTextLease,hadVoiceLease,returned}){
  if(!/^UIA_MODE_[A-Z0-9_]{1,70}$/.test(error?.code??'')||/CLEANUP_UNCONFIRMED|STOP_UNCONFIRMED|RECORDING_POSSIBLE/.test(error.code)||error.controlsCleanupFailed||hadVoiceLease||!['prepare','navigation-ready','navigation-continuation'].includes(operation))return error;
  const restored=returned?.released===true&&returned.restored===true&&returned.skipped===false;
  const unborrowed=!hadTextLease&&returned?.released===false&&returned.restored===false&&returned.skipped===true;
  if(restored||unborrowed)error[uiaVerificationRefusal]={operation,focus:restored?'restored':'not-borrowed'};
  return error;
}
function markNavigationRefusal(error,focus){
  if(error?.[navigationTransitionFailure]&&error.clipboardRestored!==false&&error.popupCleanup?.closed!==false)
    error.navigationRefusal={version:1,focus,messageInputAttempted:false};
}
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const backgroundTextTransport='window-message-background-v1';
const backgroundTextSupported=text=>typeof text==='string'&&text.length>0&&text.length<=16000&&text.isWellFormed()&&!/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(text);
const nativeLeaseId=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
export function qtEmptyEditorHashes(layout){
  if(!object(layout)||!hash(layout.emptyEditorSha256))throw fault('UI_QT_EMPTY_TEMPLATES_INVALID');
  const variants=layout.emptyEditorSha256s;
  if(variants!==undefined&&(!Array.isArray(variants)||variants.length<1||variants.length>4||variants.some(value=>!hash(value))||new Set(variants).size!==variants.length))throw fault('UI_QT_EMPTY_TEMPLATES_INVALID');
  const combined=[...new Set([layout.emptyEditorSha256,...(variants??[])])];
  if(combined.length>4)throw fault('UI_QT_EMPTY_TEMPLATES_INVALID');return combined;
}
/** A complete-image phase comparison only. The caller must retain its proven
 * empty draft, original transaction, account/contact and window guards. */
export function qtEmptyEditorPhaseMatches(before,after,verifiedHashes){
  return hash(before)&&hash(after)&&Array.isArray(verifiedHashes)&&verifiedHashes.length>0&&verifiedHashes.length<=4&&verifiedHashes.every(hash)&&
    new Set(verifiedHashes).size===verifiedHashes.length&&verifiedHashes.includes(before)&&verifiedHashes.includes(after);
}
export function validateQtEmptyDraftPhaseProof(value,editorRect,verifiedHashes){
  if(value===undefined)return undefined;
  if(!object(value)||Object.keys(value).length!==4||value.version!==1||!/^[a-f0-9]{32}$/.test(value.id??'')||!rect(value.editorRect)||Object.keys(value.editorRect).length!==4||!sameRect(value.editorRect,editorRect)||
    !Array.isArray(value.knownEmptySha256s)||value.knownEmptySha256s.length!==verifiedHashes.length||value.knownEmptySha256s.some(item=>!hash(item))||
    new Set(value.knownEmptySha256s).size!==value.knownEmptySha256s.length||value.knownEmptySha256s.some(item=>!verifiedHashes.includes(item)))throw fault('UI_QT_EMPTY_PHASE_PROOF_INVALID');
  return structuredClone(value);
}
export function validateQtEmptyDraftPhase(value,proof,frame){
  const actual=frame?.regions?.find(region=>sameRect(region.rect,proof?.editorRect))?.rgbaSha256;
  if(!object(proof)||!Array.isArray(proof.knownEmptySha256s)||!object(value)||Object.keys(value).length!==9||value.version!==1||value.emptyDraftPhaseVerified!==true||value.proofId!==proof?.id||
    value.readOnly!==true||value.inputSent!==false||value.revision!==frame?.revision||!hash(value.actualRgbaSha256)||value.actualRgbaSha256!==actual||
    !hash(value.normalizedRgbaSha256)||!proof.knownEmptySha256s.includes(value.normalizedRgbaSha256)||typeof value.caretRemoved!=='boolean'||
    (value.caretRemoved?value.actualRgbaSha256===value.normalizedRgbaSha256:value.actualRgbaSha256!==value.normalizedRgbaSha256))throw fault('UI_QT_EMPTY_PHASE_UNVERIFIED');
  return structuredClone(value);
}
const positiveDecimal=value=>typeof value==='string'&&/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n;
function validForegroundLease(value){return object(value)&&Object.keys(value).length===3&&value.version===1&&Number.isSafeInteger(value.startedAtTickMs)&&value.startedAtTickMs>0&&typeof value.includesContactNavigation==='boolean';}
function pixelMismatchDiagnostic(value){return object(value)&&Object.keys(value).length===2&&['capture','guard'].includes(value.stage)&&Number.isSafeInteger(value.anchorIndex)&&value.anchorIndex>=0&&value.anchorIndex<8?{stage:value.stage,anchorIndex:value.anchorIndex}:undefined;}
function validUiaPointerDelivery(value,scope){return object(value)&&Object.keys(value).length===8&&value.version===1&&value.method==='window-message-v1'&&value.scope===scope&&value.messagesPosted===3&&value.queueAccepted===true&&value.systemCursorMovementRequested===false&&value.cursorUnchanged===true&&value.completion===(scope==='editor-focus'?'uia-focus':'receipt-pending');}
function uiaEditorFocusReused(value){return value?.performed===true&&value.attempted===false&&value.inputSent===false&&value.editorFocused===true&&value.editorFocusReused===true&&value.pointerDelivery===null;}
function backgroundProgressDiagnostic(value,action){
  const keys=['version','transport','phase','editorClickAttempted','retainedEditorRoute','charactersPosted','mouseMessagesPosted','writeStarted','submitStarted','originalForegroundIsWechat','currentForegroundIsWechat','retryAllowed'];
  const phases=['prepared','write-preflight','characters','value-confirmation','written','submit-preflight','submit-messages','submit-consumption','submit-consumed'];
  if(!['prepareUiaBackgroundText','writeUiaBackgroundText','submitUiaBackgroundText','releaseUiaBackgroundText'].includes(action)||!object(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key))||
    value.version!==1||value.transport!==backgroundTextTransport||!phases.includes(value.phase)||value.editorClickAttempted!==false||value.retryAllowed!==false||
    !['retainedEditorRoute','writeStarted','submitStarted','originalForegroundIsWechat','currentForegroundIsWechat'].every(key=>typeof value[key]==='boolean')||
    !Number.isSafeInteger(value.charactersPosted)||value.charactersPosted<0||value.charactersPosted>16000||!Number.isSafeInteger(value.mouseMessagesPosted)||value.mouseMessagesPosted<0||value.mouseMessagesPosted>3)return undefined;
  return structuredClone(value);
}
function imageClipboardDiagnostic(value){
  const stages=['source','frame','original','before-publish','published','closed','before-input','consumer','restore'];
  const code=v=>v===null||typeof v==='string'&&/^[A-Z][A-Z0-9_]{2,90}$/.test(v);
  if(!object(value)||Object.keys(value).length!==6||value.version!==1||!stages.includes(value.stage)||![0,8,15].includes(value.format)||!code(value.operationFailure)||!code(value.cleanupFailure)||!Array.isArray(value.states)||value.states.length>10||!value.states.every(s=>object(s)&&Object.keys(s).length===4&&stages.includes(s.stage)&&Number.isSafeInteger(s.sequence)&&s.sequence>=0&&s.sequence<=0xffffffff&&typeof s.ownerMatched==='boolean'&&(s.formats===null||Array.isArray(s.formats)&&s.formats.length<=8&&s.formats.every(f=>Number.isSafeInteger(f)&&f>0&&f<=0xffff))))return undefined;
  return structuredClone(value);
}
function popupBindingMismatchDiagnostic(value){
  const diagnosticRect=value=>object(value)&&Object.keys(value).length===4&&['left','top','right','bottom'].every(key=>Number.isSafeInteger(value[key])&&Math.abs(value[key])<=65536)&&value.right>value.left&&value.bottom>value.top;
  const windowFlags=['available','sameBoundWindow','previouslyVisible','visible','minimized','identityReadable','processMatches','threadMatches','classMatches','styleMatches','extendedStyleMatches','dpiMatches','ownerMatches','boundsInsideRoot','observedGeometryAllowed'],windowRects=['windowRectInRoot','clientRect','clientRectInRoot'];
  const validWindow=window=>object(window)&&['available','sameBoundWindow','previouslyVisible'].every(key=>typeof window[key]==='boolean')&&Object.keys(window).every(key=>windowFlags.includes(key)?typeof window[key]==='boolean'||['ownerMatches','observedGeometryAllowed'].includes(key)&&window[key]===null:windowRects.includes(key)?diagnosticRect(window[key]):key==='dpi'&&Number.isSafeInteger(window[key])&&window[key]>=0&&window[key]<=4096);
  const flags=['inputAttempted','readOnly','authorizationGranted','observationAfterFailure','observed','revisionUnchangedBefore','revisionUnchangedAfter','foregroundIsRoot','foregroundIsPopup','enumerationComplete'];
  const areas=['boundWindowRectInRoot','boundClientRect','boundClientRectInRoot','frameWindowRectInRoot','frameClientRect'];
  const fields=['version','stage','pasteStage','kind','boundNow','visibleCandidates','elapsedMs',...flags,...areas];
  if(!object(value)||Object.keys(value).some(key=>!fields.includes(key))||value.version!==1||!['bind','active','frame','paste-completion'].includes(value.stage)||!['none','initial-guard','before-publish','before-paste','paste-settle','select-settle','copy-readback','readback-verified','end-settle','clipboard-restored','clipboard-replaced'].includes(value.pasteStage)||!['profile','search'].includes(value.kind)||
    !flags.every(key=>typeof value[key]==='boolean')||value.readOnly!==true||value.authorizationGranted!==false||value.observationAfterFailure!==true||!Number.isSafeInteger(value.elapsedMs)||value.elapsedMs<0||value.elapsedMs>60000||!areas.slice(0,3).every(key=>diagnosticRect(value[key]))||areas.slice(3).some(key=>value[key]!==undefined&&!diagnosticRect(value[key]))||
    !validWindow(value.boundNow)||!Array.isArray(value.visibleCandidates)||value.visibleCandidates.length>8||!value.visibleCandidates.every(validWindow))return undefined;
  return structuredClone(value);
}
function incompleteForegroundInterval(value){
  const intervals=sanitizeForegroundIntervals([value],{phases:['contact-navigation','preparation'],maxCount:1});
  return intervals?{...intervals[0],complete:false}:undefined;
}
function validFocusHandoff(value){const w=value?.returnWindow;return object(value)&&Object.keys(value).every(key=>['version','returnWindow','activation','foregroundLease'].includes(key))&&value.version===1&&object(w)&&Object.keys(w).length===3&&positiveDecimal(w.hwnd)&&positiveDecimal(w.processCreatedFileTimeUtc)&&Number.isSafeInteger(w.pid)&&w.pid>0&&w.pid<=0xffffffff&&(value.activation===undefined||object(value.activation)&&Object.keys(value.activation).length===2&&validFocusActivation(value.activation))&&(value.foregroundLease===undefined||validForegroundLease(value.foregroundLease));}
function transferredFocusValidation(value,frame,originalHandoff,now){
  const c=value?.cleanup,w=c?.wechatWindow,r=c?.returnWindow,returned=value?.focusHandoff?.returnWindow,original=originalHandoff?.returnWindow;
  const matches=(a,b)=>object(a)&&object(b)&&['hwnd','pid','processCreatedFileTimeUtc'].every(key=>a[key]===b[key]);
  const timestampValid=Number.isSafeInteger(c?.issuedAtMs)&&c.issuedAtMs>0,age=timestampValid?now-c.issuedAtMs:null;
  const result={version:1,transferred:value?.transferred===true,handoffValid:validFocusHandoff(value?.focusHandoff),revisionMatches:value?.revision===frame?.revision,
    cleanupShapeValid:object(c)&&Object.keys(c).length===5&&c.version===1&&validFocusHandoff({version:1,returnWindow:w})&&validFocusHandoff({version:1,returnWindow:r}),
    wechatMatchesFrame:matches(w,frame?.binding),returnMatchesOriginal:matches(r,original),returnMatchesHandoff:matches(r,returned),handoffMatchesOriginal:matches(returned,original),
    distinctProcesses:object(w)&&object(r)&&r.pid!==w.pid,lastInputTickValid:Number.isSafeInteger(c?.lastInputTick)&&c.lastInputTick>=0&&c.lastInputTick<=0xffffffff,
    // Native UTC and V8's clock can straddle a Windows clock tick. The native
    // owner still enforces its monotonic lease, identity and input generation.
    timestampValid,ageValid:timestampValid&&age>=-16&&age<=30000,ageMs:Number.isSafeInteger(age)&&Math.abs(age)<=60000?age:null};
  // Cleanup is a separate capability. Its native endpoint rechecks expiry,
  // both process identities and the actual last-input tick before restoring.
  result.cleanupAvailable=result.transferred&&result.cleanupShapeValid&&result.wechatMatchesFrame&&result.returnMatchesOriginal&&result.distinctProcesses&&result.lastInputTickValid&&result.timestampValid;
  result.valid=result.cleanupAvailable&&result.handoffValid&&result.revisionMatches&&result.returnMatchesHandoff&&result.handoffMatchesOriginal&&result.ageValid;
  return result;
}
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u0020\u007f]/u.test(value);
const alias = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const rect = value => object(value) && ['left','top','right','bottom'].every(key => Number.isSafeInteger(value[key])) && value.left >= 0 && value.top >= 0 && value.right > value.left && value.bottom > value.top;
function validVoiceLayout(voice,layout,uia=false){
  if(!object(voice)||!object(layout)||voice.mouseParkRect===undefined&&(!uia||!object(voice.recordingUi?.uia)))return false;
  try{validateVoiceRecordingLayout({recordingUi:voice.recordingUi,clientRect:{left:0,top:0,right:layout.width,bottom:layout.height},recordStartRect:voice.recordStartRect,...(voice.mouseParkRect!==undefined?{mouseParkRect:voice.mouseParkRect}:{}),editorRect:layout.editor,dpi:layout.dpi,allowSameFocus:true});return true;}catch{return false;}
}
const inside = (outer, inner) => inner.left >= outer.left && inner.top >= outer.top && inner.right <= outer.right && inner.bottom <= outer.bottom;
const sameRect=(a,b)=>object(a)&&object(b)&&['left','top','right','bottom'].every(key=>a[key]===b[key]);
const validFocusActivation=(value,width=4096)=>rect(value?.rect)&&(hash(value.rgbaSha256)&&value.mode===undefined||['blank-caption-v1','uia-caption-v1'].includes(value.mode)&&value.rgbaSha256===undefined)&&value.rect.left>=160&&value.rect.right<=width-160&&value.rect.bottom<=48&&value.rect.right-value.rect.left>=20&&value.rect.right-value.rect.left<=200&&value.rect.bottom-value.rect.top>=8&&value.rect.bottom-value.rect.top<=40;
// Geometry for a fresh guarded pointer move only, matching QtCanParkPointer.
// This cannot supply the pixel proof required to activate a background window.
const validPointerParkRect=(value,width)=>rect(value)&&Object.keys(value).length===4&&value.left>=160&&value.right<=width-160&&value.bottom<=48&&value.right-value.left>=20&&value.right-value.left<=200&&value.bottom-value.top>=8&&value.bottom-value.top<=40;
function validatePopupCalibration(value, kind) {
  const bounds=value?.windowRect;
  if(!object(value)||Object.keys(value).length!==(Object.hasOwn(value,'heightVariants')||Object.hasOwn(value,'heightRange')?11:10)||value.version!==1||value.kind!==kind||typeof value.className!=='string'||value.className.length<1||value.className.length>256||/[\0\r\n]/u.test(value.className)||
      !['root-owned','same-thread-unowned'].includes(value.ownerRelation)||!Number.isSafeInteger(value.ownerDepth)||(value.ownerRelation==='root-owned'?(value.ownerDepth<1||value.ownerDepth>16):value.ownerDepth!==0)||
      !['clientWidth','clientHeight'].every(key=>Number.isSafeInteger(value[key])&&value[key]>=20&&value[key]<=4096)||
      !['style','extendedStyle'].every(key=>Number.isSafeInteger(value[key])&&value[key]>=-2147483648&&value[key]<=4294967295)||
      !object(bounds)||Object.keys(bounds).length!==4||!['left','top','right','bottom'].every(key=>Number.isSafeInteger(bounds[key])&&bounds[key]>=-32768&&bounds[key]<=32768)||bounds.right<=bounds.left||bounds.bottom<=bounds.top||bounds.right-bounds.left>4096||bounds.bottom-bounds.top>4096)throw fault('UI_QT_POPUP_CALIBRATION_INVALID');
  if(Object.hasOwn(value,'heightVariants')&&(kind!=='search'||!Array.isArray(value.heightVariants)||value.heightVariants.length<1||value.heightVariants.length>4||new Set(value.heightVariants).size!==value.heightVariants.length||value.heightVariants.some(n=>!Number.isInteger(n)||n<20||n>4096)||bounds.bottom-bounds.top!==value.clientHeight))throw fault('UI_QT_POPUP_CALIBRATION_INVALID');
  if(Object.hasOwn(value,'heightRange')&&(kind!=='search'||!object(value.heightRange)||Object.keys(value.heightRange).length!==2||!Number.isInteger(value.heightRange.min)||!Number.isInteger(value.heightRange.max)||value.heightRange.min<20||value.heightRange.max>4096||value.heightRange.min>value.clientHeight||value.heightRange.max<value.clientHeight||bounds.bottom-bounds.top!==value.clientHeight))throw fault('UI_QT_POPUP_CALIBRATION_INVALID');
  return value;
}
const popupIdentityFields=['version','kind','className','ownerRelation','ownerDepth','style','extendedStyle'];
/** Only identity already established for this executable build is reusable.
 * This conversion never supplies or guesses a popup position. */
export function toObservedPopupCalibration(value,kind){
  if(!object(value))throw fault('UI_QT_POPUP_CALIBRATION_INVALID');
  if(Object.keys(value).length!==7){validatePopupCalibration(value,kind);value=Object.fromEntries(popupIdentityFields.map(key=>[key,value[key]]));}
  if(Object.keys(value).some(key=>!popupIdentityFields.includes(key))||value.version!==1||value.kind!==kind||!['profile','search'].includes(kind)||typeof value.className!=='string'||value.className.length<1||value.className.length>256||/[\0\r\n]/u.test(value.className)||!['root-owned','same-thread-unowned'].includes(value.ownerRelation)||!Number.isSafeInteger(value.ownerDepth)||(value.ownerRelation==='root-owned'?(value.ownerDepth<1||value.ownerDepth>16):value.ownerDepth!==0)||!['style','extendedStyle'].every(key=>Number.isSafeInteger(value[key])&&value[key]>=-2147483648&&value[key]<=4294967295))throw fault('UI_QT_POPUP_CALIBRATION_INVALID');
  return structuredClone(value);
}
const noLinks = file => { for (let at = path.resolve(file);;) { if (fs.lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('UI_QT_LINK_REFUSED'); const parent = path.dirname(at); if (parent === at) return path.resolve(file); at = parent; } };
function quoteDraftDirectory(root,accountRef){
  if(!path.isAbsolute(root)||!hash(accountRef))throw fault('UI_QT_QUOTE_SCOPE_INVALID');
  return path.join(root,'state','ui-quote-drafts',accountRef);
}
function quoteDraftFile(root,accountRef,target){
  if(typeof target!=='string'||!target)throw fault('UI_QT_QUOTE_SCOPE_INVALID');
  return path.join(quoteDraftDirectory(root,accountRef),crypto.createHash('sha256').update(target).digest('hex')+'.json');
}
export function confirmQuoteDraftSent(root,accountRef,target,deliveryId){
  if(!hash(deliveryId))throw fault('UI_QT_QUOTE_SCOPE_INVALID');
  const file=noLinks(quoteDraftFile(root,accountRef,target));
  if(!fs.existsSync(file)||JSON.parse(fs.readFileSync(file,'utf8')).id!==deliveryId)return false;
  fs.unlinkSync(file);return true;
}
export function clearQuoteDraftMarkers(root,accountRef,target){
  const file=noLinks(quoteDraftFile(root,accountRef,target));
  if(!fs.existsSync(file))return false;
  fs.unlinkSync(file);return true;
}
const regions = ['header','search','firstResult','profileOpen','profileAlias','profileClose','selfOpen','selfAlias','selfClose','editor','send'];
function validConversationFingerprint(value){return object(value)&&Object.keys(value).length===7&&value.version===1&&value.scope==='chat-title-text-v1'&&value.targetVerified===false&&['sha256','headerRuntimeIdSha256','titleRuntimeIdSha256'].every(key=>hash(value[key]))&&Number.isInteger(value.textNodeCount)&&value.textNodeCount>=1&&value.textNodeCount<=4;}
function validUiaImageProof(value,image){return object(value)&&Object.keys(value).length===4&&value.version===1&&/^[a-f0-9]{32}$/.test(value.id??'')&&hash(value.imageSha256)&&value.imageSha256===image?.sha256&&value.imageFormat===(image.format==='file'?'file':image.format==='gif'?'gif':'static');}
const codeFor = error => /^(?:UI_|UIA_MODE_|QT_|DRAFT_|CONTACT_IDENTITY_)[A-Z0-9_]{1,80}$/.test(error?.code ?? '') ? error.code : 'UI_QT_OPERATION_FAILED';
function focusConfirmationDiagnostic(value){
  if(!object(value)||!['attempted','accepted','confirmed'].every(key=>typeof value[key]==='boolean')||!Number.isSafeInteger(value.elapsedMs)||value.elapsedMs<0||value.elapsedMs>60000||!['guard-failed','foreground-changed','request-rejected','timeout','confirmed'].includes(value.reason))return undefined;
  const report=Object.fromEntries(['attempted','accepted','confirmed','elapsedMs','reason'].map(key=>[key,value[key]])),activation=value.activation;
  const numbers=['currentThreadId','sourceThreadId','targetThreadId','attachError','detachError','foregroundLastError'],flags=['attachmentNeeded','attached','detached','foregroundLastErrorInformational'];
  if(object(activation)&&numbers.every(key=>Number.isSafeInteger(activation[key])&&activation[key]>=0&&activation[key]<=0xffffffff)&&flags.every(key=>typeof activation[key]==='boolean')&&['not-requested','source','target','none','other'].includes(activation.foregroundAfter))report.activation=Object.fromEntries([...numbers,...flags,'foregroundAfter'].map(key=>[key,activation[key]]));
  if(report.activation)for(const key of ['calibratedClickAttempted','calibratedClickApplied','pointerRestored','returnCaptionConsidered','returnCaptionAttempted','returnCaptionApplied','returnCaptionVerified','returnRaiseAttempted','returnRaiseAccepted','returnRaiseConfirmed','foregroundRequestAccepted','alreadyTargetWithoutClick','calibratedRaiseAttempted','calibratedRaiseAccepted','sourceLowerAttempted','sourceLowerAccepted','automaticBlankCaption'])if(typeof activation[key]==='boolean')report.activation[key]=activation[key];
  if(report.activation){if(typeof activation.allPointsOwned==='boolean')report.activation.allPointsOwned=activation.allPointsOwned;for(const key of ['actualRgbaSha256','expectedRgbaSha256'])if(hash(activation[key]))report.activation[key]=activation[key];}
  const cleanup=activation?.raiseCleanup;
  if(report.activation&&object(cleanup)&&Object.keys(cleanup).length===4&&typeof cleanup.attempted==='boolean'&&(cleanup.accepted===null||typeof cleanup.accepted==='boolean')&&typeof cleanup.confirmed==='boolean'&&['no-raise','click-attempted','original-order-preserved','guard-pending','restore-timeout','source-order-restored','source-activity-or-binding-changed'].includes(cleanup.reason))report.activation.raiseCleanup={attempted:cleanup.attempted,accepted:cleanup.accepted,confirmed:cleanup.confirmed,reason:cleanup.reason};
  return report;
}
function focusRestoreOutcomeDiagnostic(value){
  const flags=['restored','skipped','foregroundOwnedByWechat','identitiesUnchanged','activityUnchanged','keysReleased','parkRevisionUnchanged'];
  const fields=['version','reason',...flags],reasons=['lease-absent','foreground-not-wechat','identity-changed','activity-changed','keys-held','conditions-satisfied','foreground-check-failed','identity-check-failed','keys-check-failed','restore-confirmation-failed','pointer-restore-failed','restored','park-activity-changed'];
  if(!object(value)||Object.keys(value).length!==fields.length||Object.keys(value).some(key=>!fields.includes(key))||value.version!==1||!reasons.includes(value.reason)||!flags.every(key=>value[key]===null||typeof value[key]==='boolean'))return undefined;
  return Object.fromEntries(fields.map(key=>[key,value[key]]));
}
function visibilityRestoreOutcomeDiagnostic(value){
  const flags=['restored','foregroundPreserved','identitiesUnchanged','activityUnchanged','placementUnchanged','topmostUnchanged'],extended=object(value)&&Object.hasOwn(value,'temporaryTopmost'),fields=['version','reason',...flags,...(extended?['temporaryTopmost','originalFailureCode']:[])];
  if(!object(value)||Object.keys(value).length!==fields.length||value.version!==1||!['source-order-restored','restore-unconfirmed'].includes(value.reason)||!flags.every(key=>typeof value[key]==='boolean'))return undefined;
  if(extended){const top=value.temporaryTopmost,keys=['originalTargetTopmost','temporaryTopmostAttempted','temporaryTopmostApplied','temporaryTopmostRollbackAttempted','temporaryTopmostRolledBack','topmostRollbackConfirmed','targetDestroyed'];
    if(!object(top)||Object.keys(top).length!==keys.length+1||top.version!==1||!keys.every(key=>typeof top[key]==='boolean')||value.originalFailureCode!==null&&!/^(?:QT_|DRAFT_)[A-Z0-9_]{1,72}$/.test(value.originalFailureCode??''))return undefined;
  }
  return Object.fromEntries(fields.map(key=>[key,value[key]]));
}
function raisedVisibilityIntervalDiagnostic(value){
  if(!object(value)||Object.keys(value).length!==5||value.version!==1||value.phase!=='layout-visibility'||!Number.isSafeInteger(value.durationMs)||value.durationMs<0||value.durationMs>60000||typeof value.complete!=='boolean'||value.keyboardFocusChanged!==false)return undefined;
  return {version:1,phase:value.phase,durationMs:value.durationMs,complete:value.complete,keyboardFocusChanged:false};
}
function focusVisibilityDiagnostic(value){
  const fields=['version','raiseAttempted','requestAccepted','confirmed','initialBlockingCount','lastBlockingCount','elapsedMs','reason'];
  if(!object(value)||Object.keys(value).length!==fields.length||Object.keys(value).some(key=>!fields.includes(key))||value.version!==1||typeof value.raiseAttempted!=='boolean'||typeof value.confirmed!=='boolean'||(value.requestAccepted!==null&&typeof value.requestAccepted!=='boolean')||(!value.raiseAttempted&&value.requestAccepted!==null)||!['already-visible','raised-visible','timeout','guard-failed'].includes(value.reason)||!Number.isSafeInteger(value.elapsedMs)||value.elapsedMs<0||value.elapsedMs>60000||!['initialBlockingCount','lastBlockingCount'].every(key=>value[key]===null||Number.isSafeInteger(value[key])&&value[key]>=0&&value[key]<=1000000)||(value.confirmed&&(!['already-visible','raised-visible'].includes(value.reason)||value.lastBlockingCount!==0)))return undefined;
  return Object.fromEntries(fields.map(key=>[key,value[key]]));
}
function focusReturnDiagnostics(value){
  const focusRestoreOutcome=focusRestoreOutcomeDiagnostic(value?.focusRestoreOutcome),focusConfirmation=focusConfirmationDiagnostic(value?.focusConfirmation),focusVisibility=focusVisibilityDiagnostic(value?.focusVisibility),foregroundInterval=incompleteForegroundInterval(value?.foregroundInterval);
  return {...(focusRestoreOutcome?{focusRestoreOutcome}:{}),...(focusConfirmation?{focusConfirmation}:{}),...(focusVisibility?{focusVisibility}:{}),...(foregroundInterval?{foregroundInterval}:{})};
}
// Only explicit environmental conditions are waitable. Identity, malformed
// observations, native failures and uncertain rollback remain fatal.
const preparationWaits = new Set([
  'UI_USER_ACTIVE','UI_QT_HUMAN_ACTIVITY_CHANGED','UI_QT_DRAFT_CONFLICT','UI_QT_PARTIAL_DRAFT_RECHECK_REQUIRED',
  'QT_ACTIVITY_WARMUP','QT_USER_ACTIVE','QT_HUMAN_ACTIVITY_CHANGED','QT_PIXELS_CHANGED','QT_OBSERVATION_CHANGED','QT_OBSERVATION_EXPIRED',
  'QT_RETURN_CAPTION_UNAVAILABLE','QT_RETURN_CAPTION_WARMUP',
  'QT_WINDOW_OBSCURED','QT_CLICK_OBSCURED','QT_FOCUS_UNAVAILABLE','QT_POPUP_NOT_OWNED','QT_BINDING_CHANGED',
  'DRAFT_EXECUTABLE_MISMATCH','DRAFT_WINDOW_NOT_FOREGROUND','DRAFT_WINDOW_NOT_VISIBLE','DRAFT_WINDOW_POPUP_ACTIVE',
  'DRAFT_FOCUS_UNAVAILABLE','DRAFT_KEYS_HELD','DRAFT_MENU_OR_MOVE_ACTIVE','DRAFT_DESKTOP_UNAVAILABLE',
  'DRAFT_HUMAN_ACTIVITY_CHANGED','DRAFT_EDITOR_FOCUS_CHANGED','DRAFT_CLIPBOARD_CHANGED','DRAFT_CLIPBOARD_BUSY',
]);

/** Layout coordinates are machine-local calibration, never defaults inferred
 * from a screenshot or contact display name. Resize/update forces recalibration. */
export function validateQtConfig(value) {
  const uia=value?.layoutMode==='uia-v1';
  if (!object(value) || value.version !== 1 || value.backend !== 'qt-visual' || !id(value.account) || !hash(value.accountRef) || !alias(value.accountAlias) ||
      typeof value.executable !== 'string' || !path.isAbsolute(value.executable) || !/(?:^|[\\/])(?:Weixin|WeChat)\.exe$/i.test(value.executable) ||
      typeof value.hwnd !== 'string' || value.hwnd !== 'auto' && (!/^[1-9][0-9]{0,18}$/.test(value.hwnd) || BigInt(value.hwnd) > 9223372036854775807n) ||
      typeof value.executableVersion !== 'string' || !/^\d+(\.\d+){3}$/.test(value.executableVersion) || !hash(value.executableSha256) ||
      !object(value.layout) || !Number.isInteger(value.layout.width) || value.layout.width < 600 || value.layout.width > 4096 ||
      !Number.isInteger(value.layout.height) || value.layout.height < 400 || value.layout.height > 4096 || value.layout.width * value.layout.height > 12000000 ||
      !Number.isInteger(value.layout.dpi) || value.layout.dpi < 48 || value.layout.dpi > 768 || !uia&&!hash(value.layout.emptyEditorSha256) ||
      !Number.isSafeInteger(value.idleMs) || value.idleMs < 1000 || value.idleMs > 300000 || !['windows','rapidocr'].includes(value.ocrBackend)) throw fault('UI_QT_CONFIG_INVALID');
  if(uia){
    const client={left:0,top:0,right:value.layout.width,bottom:value.layout.height};
    if(value.focusActivationMode!=='uia-caption-v1'||!['header','search','editor','send'].every(key=>rect(value.layout[key])&&inside(client,value.layout[key]))||
      Object.keys(value.layout).some(key=>!['width','height','dpi','header','search','editor','send'].includes(key))||['selfSurface','profileSurface','focusActivation','selfCloseKey','profileCloseKey'].some(key=>value[key]!==undefined))throw fault('UI_QT_LAYOUT_INVALID');
    if(value.layout.send.left<value.layout.editor.right&&value.layout.send.right>value.layout.editor.left&&value.layout.send.top<value.layout.editor.bottom&&value.layout.send.bottom>value.layout.editor.top)throw fault('UI_QT_LAYOUT_INVALID');
    toObservedPopupCalibration(value.searchPopupCalibration,'search');
    if(value.voice!==undefined&&!validVoiceLayout(value.voice,value.layout,true))throw fault('UI_QT_VOICE_CALIBRATION_REQUIRED');
    if(value.newlineKey!==undefined&&value.newlineKey!=='Shift+Enter')throw fault('UI_QT_NEWLINE_CALIBRATION_INVALID');
    return structuredClone(value);
  }
  qtEmptyEditorHashes(value.layout);
  if(value.layout.pointerParkRect!==undefined&&!validPointerParkRect(value.layout.pointerParkRect,value.layout.width))throw fault('UI_QT_POINTER_PARK_INVALID');
  if(value.layout.focusActivateRect!==undefined||value.layout.focusActivateRgbaSha256!==undefined)if(!validFocusActivation({rect:value.layout.focusActivateRect,rgbaSha256:value.layout.focusActivateRgbaSha256},value.layout.width))throw fault('UI_QT_FOCUS_CALIBRATION_INVALID');
  if(value.layoutMode!==undefined&&!['calibrated','adaptive-v1'].includes(value.layoutMode))throw fault('UI_QT_LAYOUT_INVALID');
  const adaptive=value.layoutMode==='adaptive-v1';
  const client = { left: 0, top: 0, right: value.layout.width, bottom: value.layout.height };
  if ((adaptive?['header','search','profileOpen','selfOpen','editor','send']:regions).some(key => !(['profileClose','selfClose'].includes(key) && value[key+'Key'] === 'Escape') && (!rect(value.layout[key]) || !inside(client, value.layout[key])))) throw fault('UI_QT_LAYOUT_INVALID');
  if(adaptive&&!inside(value.layout.header,value.layout.profileOpen))throw fault('UI_QT_LAYOUT_INVALID');
  if (value.layout.send.left < value.layout.editor.right && value.layout.send.right > value.layout.editor.left && value.layout.send.top < value.layout.editor.bottom && value.layout.send.bottom > value.layout.editor.top) throw fault('UI_QT_LAYOUT_INVALID');
  for(const key of ['profileSurface','selfSurface'])if(adaptive){if(!object(value[key])||Object.keys(value[key]).length!==1||value[key.slice(0,-7)+'CloseKey']!=='Escape')throw fault('UI_QT_LAYOUT_INVALID');toObservedPopupCalibration(value[key].popupCalibration,'profile');}
  else if(value[key]!==undefined){const p=value[key];if(!object(p)||!Number.isInteger(p.width)||p.width<100||p.width>4096||!Number.isInteger(p.height)||p.height<100||p.height>4096||!rect(p.alias)||!rect(p.close)||!inside({left:0,top:0,right:p.width,bottom:p.height},p.alias)||!inside({left:0,top:0,right:p.width,bottom:p.height},p.close))throw fault('UI_QT_LAYOUT_INVALID');if(p.popupCalibration!==undefined){const popup=validatePopupCalibration(p.popupCalibration,'profile');if(p.width!==popup.clientWidth||p.height!==popup.clientHeight)throw fault('UI_QT_POPUP_CALIBRATION_INVALID');}}
  // WeChat's search field belongs to the main window; only its result list is
  // a separate popup. Requiring the input field inside that list rejects the
  // actual Windows layout. The field is still bounded by the main client.
  if(adaptive)toObservedPopupCalibration(value.searchPopupCalibration,'search');
  else if(value.searchPopupCalibration!==undefined){const popup=validatePopupCalibration(value.searchPopupCalibration,'search');if(!inside(popup.windowRect,value.layout.firstResult)||popup.heightRange&&popup.windowRect.top+popup.heightRange.max>value.layout.height)throw fault('UI_QT_POPUP_CALIBRATION_INVALID');}
  if(value.newlineKey!==undefined&&value.newlineKey!=='Shift+Enter')throw fault('UI_QT_NEWLINE_CALIBRATION_INVALID');
  for(const key of ['profileCloseKey','selfCloseKey'])if(value[key]!==undefined&&value[key]!=='Escape')throw fault('UI_QT_LAYOUT_INVALID');
  if(value.layout.profileMember!==undefined||value.layout.profilePanelClose!==undefined)for(const key of ['profileMember','profilePanelClose'])if(!rect(value.layout[key])||!inside(client,value.layout[key]))throw fault('UI_QT_LAYOUT_INVALID');
  if(!adaptive&&value.layout.searchResultIdentity!==undefined){const area=value.layout.searchResultIdentity,click=value.layout.firstResult,x=(click.left+click.right)/2,y=(click.top+click.bottom)/2,popup=value.searchPopupCalibration;
    const searchBounds=popup?{...popup.windowRect,bottom:popup.windowRect.top+Math.max(popup.clientHeight,...(popup.heightVariants??[]),popup.heightRange?.max??0)}:null;
    if(!rect(area)||!inside(client,area)||!inside(area,click)||x<area.left||x>=area.right||y<area.top||y>=area.bottom||searchBounds&&!inside(searchBounds,area))throw fault('UI_QT_LAYOUT_INVALID');}
  if(value.settleMs!==undefined&&(!Number.isInteger(value.settleMs)||value.settleMs<100||value.settleMs>2000))throw fault('UI_QT_LAYOUT_INVALID');
  return structuredClone(value);
}

/** Require an exact complete alias beside the explicit WeChat-ID label. No
 * Unicode normalization, fuzzy matching, nickname matching or substring match. */
export function exactProfileAlias(ocr, area, expected) {
  if (!alias(expected) || !rect(area) || !Array.isArray(ocr?.words)) return false;
  const groups = new Map();
  for (const word of ocr.words) {
    if (!object(word) || typeof word.text !== 'string' || !Number.isSafeInteger(word.line) ||
        !['x','y','width','height'].every(key => Number.isFinite(word[key])) || word.width <= 0 || word.height <= 0 ||
        word.x < area.left || word.y < area.top || word.x + word.width > area.right || word.y + word.height > area.bottom ||
        word.confidence !== undefined && word.confidence < 0.97) continue;
    if (!groups.has(word.line)) groups.set(word.line, []);
    groups.get(word.line).push(word);
  }
  const lines = [];
  for (const words of groups.values()) {
    words.sort((a,b) => a.x - b.x);
    const text = words.map(word => word.text).join('').replace(/[ \t]/g, '');
    lines.push({text,x:words[0].x,y:Math.min(...words.map(w=>w.y)),height:Math.max(...words.map(w=>w.height))});
  }
  lines.sort((a,b)=>a.y-b.y||a.x-b.x);
  if(lines.length<1||lines.length>3)return false;
  const first=/^(?:微信号|WeChatID)[:：]([A-Za-z0-9_-]{0,256})$/.exec(lines[0].text);
  if(!first)return false;let joined=first[1];
  for(let i=1;i<lines.length;i++){
    if(!/^[A-Za-z0-9_-]{1,256}$/.test(lines[i].text)||lines[i].y<=lines[i-1].y||lines[i].y-lines[i-1].y>Math.max(lines[i].height,lines[i-1].height)*2.5||lines[i].x<lines[0].x)return false;
    joined+=lines[i].text;
  }
  return joined === expected;
}

/** The search row must itself identify an individual contact. Opening a
 * matching member profile inside a group is not proof of a private chat. */
function privateSearchResult(ocr, area, click, expected,checkConfidence=true) {
  if(!alias(expected)||!rect(area)||!rect(click)||!inside(area,click)||!Array.isArray(ocr?.words))return false;
  const lines=new Map();
  for(const word of ocr.words){
    if(!object(word)||!['x','y','width','height'].every(key=>Number.isFinite(word[key]))||word.width<=0||word.height<=0)continue;
    if(word.x+word.width<=area.left||word.x>=area.right||word.y+word.height<=area.top||word.y>=area.bottom)continue;
    if(word.x<area.left||word.x+word.width>area.right||word.y<area.top||word.y+word.height>area.bottom||typeof word.text!=='string'||!word.text.isWellFormed()||/[\0\r\n]/.test(word.text)||!Number.isSafeInteger(word.line))return false;
    const minimum=/^\s*[:：]\s*$/.test(word.text)?0.8:0.97;
    if(word.confidence!==undefined&&(!Number.isFinite(word.confidence)||checkConfidence&&word.confidence<minimum))return false;
    if(!lines.has(word.line))lines.set(word.line,[]);lines.get(word.line).push(word);
  }
  const ordered=[...lines.values()].map(words=>{words.sort((a,b)=>a.x-b.x);return{text:words.map(w=>w.text).join('').replace(/[ \t]/g,''),top:Math.min(...words.map(w=>w.y)),bottom:Math.max(...words.map(w=>w.y+w.height))};}).sort((a,b)=>a.top-b.top);
  if(ordered.length!==3||!/^(?:联系人|最常使用|Contacts|FrequentlyUsed)$/.test(ordered[0].text)||!ordered[1].text||ordered[1].text.length>256)return false;
  if(ordered.some(line=>/(?:群聊|群成员|包含|聊天记录|公众号|小程序|GroupChats?|GroupMembers?|ChatHistory|OfficialAccounts?|Contains?)/i.test(line.text)))return false;
  const found=/^(?:微信号|WeChatID)[:：]([A-Za-z0-9_-]{1,256})$/.exec(ordered[2].text);
  if(!found||found[1]!==expected||ordered[0].bottom>ordered[1].top||ordered[1].bottom>ordered[2].top)return false;
  const x=(click.left+click.right)/2,y=(click.top+click.bottom)/2;
  return x>=area.left&&x<area.right&&y>=ordered[0].bottom&&y<ordered[2].bottom;
}
export function exactPrivateSearchResult(ocr,area,click,expected){return privateSearchResult(ocr,area,click,expected,true);}

function observedOcrLines(ocr,area){
  if(!rect(area)||!Array.isArray(ocr?.words)||ocr.words.length>2000)return null;
  const groups=new Map();
  for(const word of ocr.words){
    if(!object(word)||typeof word.text!=='string'||!word.text.isWellFormed()||/[\0\r\n]/.test(word.text)||!Number.isSafeInteger(word.line)||!['x','y','width','height'].every(key=>Number.isFinite(word[key]))||word.width<=0||word.height<=0)return null;
    if(word.x+word.width<=area.left||word.x>=area.right||word.y+word.height<=area.top||word.y>=area.bottom)continue;
    if(word.x<area.left||word.y<area.top||word.x+word.width>area.right||word.y+word.height>area.bottom)return null;
    if(!groups.has(word.line))groups.set(word.line,[]);groups.get(word.line).push(word);
  }
  return [...groups.values()].map(words=>{words.sort((a,b)=>a.x-b.x);return{words,text:words.map(w=>w.text).join('').replace(/[ \t]/g,''),left:Math.min(...words.map(w=>w.x)),right:Math.max(...words.map(w=>w.x+w.width)),top:Math.min(...words.map(w=>w.y)),bottom:Math.max(...words.map(w=>w.y+w.height))};}).sort((a,b)=>a.top-b.top||a.left-b.left);
}
const confidentLine=line=>line.words.every(word=>word.confidence===undefined||Number.isFinite(word.confidence)&&word.confidence>=(/^\s*[:：]\s*$/.test(word.text)?0.8:0.97));
const lineBox=lines=>({left:Math.floor(Math.min(...lines.map(line=>line.left))),top:Math.floor(Math.min(...lines.map(line=>line.top))),right:Math.ceil(Math.max(...lines.map(line=>line.right))),bottom:Math.ceil(Math.max(...lines.map(line=>line.bottom)))});
/** Locate the explicit ID in the whole causally bound profile, without using
 * old DPI coordinates or giving expected text to the OCR engine. */
export function observedProfileAlias(ocr,area,expected){
  if(!alias(expected))return null;const lines=observedOcrLines(ocr,area);if(!lines)return null;
  const matches=lines.filter(line=>/(?:微信号|WeChatID)/.test(line.text));if(matches.length!==1)return null;
  const first=matches[0],match=/^(?:微信号|WeChatID)[:：]([A-Za-z0-9_-]{0,256})$/.exec(first.text);if(!match||!confidentLine(first))return null;
  // Whole-profile OCR also sees the avatar/left margin. A fully separate left
  // column cannot interrupt a wrapped ID. Exclude it only by geometry, with a
  // full line-height gap; keep touching/overlapping and all right-side rows.
  // The unique-label check above still covers every column.
  const firstHeight=first.bottom-first.top,column=lines.filter(line=>line===first||first.left-line.right<Math.max(firstHeight,line.bottom-line.top));
  let found=match[1];const used=[first];let index=column.indexOf(first)+1;
  // Only an immediately adjacent ASCII continuation can complete a wrapped ID.
  // OCR glyph boxes can extend slightly across adjacent baselines. Require a
  // distinct lower line advancing at least 3/4 of the larger line height;
  // this admits that padding without merging same-row or overlapping text.
  while(index<column.length){
    const next=column[index],prior=used.at(-1),nextHeight=next.bottom-next.top,priorHeight=prior.bottom-prior.top,height=Math.max(nextHeight,priorHeight),advance=next.top-prior.top,overlap=prior.bottom-next.top;
    if(!/^[A-Za-z0-9_-]{1,256}$/.test(next.text))break;
    // Duplicate/overlapping OCR rows cannot be ignored after a complete ID:
    // they leave the apparent continuation ambiguous rather than complete.
    if(overlap>0&&(advance<height*.75||overlap>Math.min(nextHeight,priorHeight)*.25||next.bottom<=prior.bottom))return null;
    if(advance>height*2.5)break;
    // Never turn the three-line limit into a successful truncated identity.
    // A nearby same-column row with invalid geometry is ambiguous, not an end marker.
    if(advance<height*.75||next.bottom<=prior.bottom||next.left<first.left||used.length>=3||!confidentLine(next))return null;used.push(next);found+=next.text;index++;
  }
  if(found!==expected)return null;const result=lineBox(used);return rect(result)&&inside(area,result)?result:null;
}
/** Only one complete private section is admissible. A separately labelled
 * group/history/network section below it cannot turn a member into a contact. */
export function observedPrivateSearchResult(ocr,area,expected,checkConfidence=true){
  if(!alias(expected))return null;let lines=observedOcrLines(ocr,area);if(!lines||lines.length<3)return null;
  const privateHeading=/^(?:联系人|最常使用|Contacts|FrequentlyUsed)$/;
  if(!privateHeading.test(lines[0].text)||lines.slice(1).some(line=>privateHeading.test(line.text)))return null;
  if(lines.length>3){
    const heading=lines[0],name=lines[1],boundary=lines[3],height=Math.max(heading.bottom-heading.top,boundary.bottom-boundary.top);
    // This is an observed section boundary, not a guessed first-result crop.
    // It must be a complete, confident category label in the heading column,
    // clearly to the left of the contact's text column and below its full ID.
    if(!/^(?:群聊|聊天记录|公众号|小程序|更多|GroupChats?|ChatHistory|OfficialAccounts?|MiniPrograms?|More)$/.test(boundary.text)
      ||!confidentLine(boundary)||Math.abs(boundary.left-heading.left)>height*.5||name.left-heading.left<height
      ||boundary.bottom<=boundary.top||lines[2].bottom>boundary.top)return null;
    lines=lines.slice(0,3);
  }
  if(checkConfidence&&lines.some(line=>!confidentLine(line)))return null;
  if(!lines[1].text||lines[1].text.length>256||lines.some(line=>/(?:群聊|群成员|包含|聊天记录|公众号|小程序|GroupChats?|GroupMembers?|ChatHistory|OfficialAccounts?|Contains?)/i.test(line.text)))return null;
  const matched=/^(?:微信号|WeChatID)[:：]([A-Za-z0-9_-]{1,256})$/.exec(lines[2].text);
  if(!matched||matched[1]!==expected||lines[0].bottom>lines[1].top||lines[1].bottom>lines[2].top)return null;
  const row=lineBox(lines.slice(1)),identity=lineBox(lines);
  // Clicking the observed name/ID text itself stays within the proved row.
  const click=lineBox([lines[1]]);if(!rect(click)||!inside(area,click)||!inside(row,click))return null;
  return{area:identity,click};
}

/** Native stdin/stdout is private. Startup does not activate WeChat. */
export class QtActionsClient {
  constructor({ root, config, enableInput = false, calibration = false, spawnImpl = spawn, timeoutMs = 20000, closeTimeoutMs = 3000 }) {
    if(calibration){if(enableInput!==false||!object(config)||typeof config.executable!=='string'||!path.isAbsolute(config.executable)||!hash(config.executableSha256)||config.hwnd!=='auto')throw fault('UI_QT_CALIBRATION_OPTIONS_INVALID');this.config=structuredClone(config);}
    else this.config = validateQtConfig(config);
    this.root = path.resolve(root); this.spawnImpl = spawnImpl; this.enableInput = enableInput;
    if (typeof enableInput !== 'boolean' || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 25000 || !Number.isInteger(closeTimeoutMs) || closeTimeoutMs < 10 || closeTimeoutMs > 5000) throw fault('UI_QT_CLIENT_OPTIONS_INVALID');
    this.timeoutMs = timeoutMs; this.closeTimeoutMs = closeTimeoutMs; this.sequence = 0; this.child = null; this.pending = null; this.failure = null; this.closed = false;
    this.closePromise = null; this.stopId = null; this.stopAcknowledged = false; this.exitResult = null; this.cleanupUnconfirmed = false;
  }
  start() {
    if (this.closed || this.failure) throw this.failure ?? fault('UI_QT_CLOSED');
    if (this.child) return;
    const binary = noLinks(path.join(this.root, 'state/ui-host/WechatQtActions.exe'));
    const frames = noLinks(path.join(this.root, 'state/ui-host/qt-frames'));
    if (!fs.statSync(binary, { throwIfNoEntry: false })?.isFile()) throw fault('UI_QT_COMPONENT_MISSING');
    noLinks(this.config.executable);
    if (crypto.createHash('sha256').update(fs.readFileSync(this.config.executable)).digest('hex') !== this.config.executableSha256) throw fault('UI_QT_RECALIBRATION_REQUIRED');
    fs.mkdirSync(frames, { recursive: true }); this.frames = frames;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('CODEX') && !['NODE_OPTIONS','NODE_PATH','PYTHONHOME','PYTHONPATH'].includes(key.toUpperCase())));
    const child = this.spawnImpl(binary, ['--executable',this.config.executable,'--hwnd',this.config.hwnd,'--frames',frames,this.enableInput ? '--enable-input' : '--read-only'], { cwd: this.root, windowsHide: true, shell: false, stdio: ['pipe','pipe','pipe'], env });
    this.child = child; const decoder = new StringDecoder('utf8'); let buffer = '', bytes = 0, errBytes = 0;
    child.stdout.on('data', chunk => {
      bytes += chunk.length; if (bytes > 1024 * 1024) return this.fail(fault('UI_QT_PROTOCOL_INVALID'));
      buffer += decoder.write(chunk);
      for (;;) { const index = buffer.indexOf('\n'); if (index < 0) break;
        let packet; try { packet = JSON.parse(buffer.slice(0,index)); } catch { return this.fail(fault('UI_QT_PROTOCOL_INVALID')); }
        buffer = buffer.slice(index+1); bytes = Buffer.byteLength(buffer);
        if (packet?.id === null && packet.ok === false) return this.fail(fault(codeFor(packet.error)));
        if (packet?.id === this.stopId && this.stopId !== null) {
          if (packet.ok !== true || packet.result?.stopped !== true || this.stopAcknowledged) return this.fail(fault('UI_QT_PROTOCOL_INVALID'));
          this.stopAcknowledged = true; continue;
        }
        const pending = this.pending;
        if (!pending || packet?.id !== pending.id || typeof packet.ok !== 'boolean') return this.fail(fault('UI_QT_PROTOCOL_INVALID'));
        if (packet.ok && object(packet.result)) this.finishPending(null,packet.result);
        else if (!packet.ok && object(packet.error)) this.finishPending(fault(codeFor(packet.error), {
          nativeAction: pending.action,
          ...(packet.error.attempted === false ? {attempted:false} : {}),
          ...(typeof packet.error.clipboardRestored === 'boolean' ? {clipboardRestored:packet.error.clipboardRestored} : {}),
          ...(pending.allowClipboardReplacement && packet.error.clipboardRestored===false && packet.error.clipboardReplaced===true ? {clipboardReplaced:true} : {}),
          ...(packet.error.originalClipboardBlocked===true && packet.error.attempted===false && packet.error.clipboardRestored===true ? {originalClipboardBlocked:true} : {}),
          ...(focusConfirmationDiagnostic(packet.error.focusConfirmation)?{focusConfirmation:focusConfirmationDiagnostic(packet.error.focusConfirmation)}:{}),
          ...(focusRestoreOutcomeDiagnostic(packet.error.focusRestoreOutcome)?{focusRestoreOutcome:focusRestoreOutcomeDiagnostic(packet.error.focusRestoreOutcome)}:{}),
          ...(visibilityRestoreOutcomeDiagnostic(packet.error.visibilityRestoreOutcome)?{visibilityRestoreOutcome:visibilityRestoreOutcomeDiagnostic(packet.error.visibilityRestoreOutcome)}:{}),
          ...(raisedVisibilityIntervalDiagnostic(packet.error.raisedVisibilityInterval)?{raisedVisibilityInterval:raisedVisibilityIntervalDiagnostic(packet.error.raisedVisibilityInterval)}:{}),
          ...(focusVisibilityDiagnostic(packet.error.focusVisibility)?{focusVisibility:focusVisibilityDiagnostic(packet.error.focusVisibility)}:{}),
          ...(incompleteForegroundInterval(packet.error.foregroundInterval)?{foregroundInterval:incompleteForegroundInterval(packet.error.foregroundInterval)}:{}),
          ...(packet.error.code==='QT_PIXELS_CHANGED'&&pixelMismatchDiagnostic(packet.error.pixelMismatch)?{pixelMismatch:pixelMismatchDiagnostic(packet.error.pixelMismatch)}:{}),
          ...(packet.error.code==='QT_POPUP_BINDING_CHANGED'&&popupBindingMismatchDiagnostic(packet.error.popupBindingMismatch)?{popupBindingMismatch:popupBindingMismatchDiagnostic(packet.error.popupBindingMismatch)}:{}),
          ...(imageClipboardDiagnostic(packet.error.imageClipboard)?{imageClipboard:imageClipboardDiagnostic(packet.error.imageClipboard)}:{}),
          ...(backgroundProgressDiagnostic(packet.error.backgroundProgress,pending.action)?{backgroundProgress:backgroundProgressDiagnostic(packet.error.backgroundProgress,pending.action)}:{}),
        }));
        else { this.finishPending(fault('UI_QT_PROTOCOL_INVALID')); return this.fail(fault('UI_QT_PROTOCOL_INVALID')); }
      }
    });
    child.stderr.on('data', chunk => { errBytes += chunk.length; if (errBytes > 65536) this.fail(fault('UI_QT_PROTOCOL_INVALID')); });
    child.stdin.on('error', () => this.fail(fault('UI_QT_PIPE_FAILED')));
    child.on('error', () => this.fail(fault('UI_QT_START_FAILED')));
    // close follows drained stdout. An exit event can precede the final rollback
    // response and must not reject or kill a helper while that response is in flight.
    this.exitPromise = new Promise(resolve => child.on('close',(code,signal) => {
      this.exitResult = {code,signal};
      if (this.pending) this.finishPending(fault('UI_QT_EXITED'));
      if (!this.closed) this.failure ??= fault('UI_QT_EXITED');
      resolve(this.exitResult);
    }));
  }
  finishPending(error, result) {
    const pending=this.pending;if(!pending)return;clearTimeout(pending.timer);this.pending=null;
    if (['readDraft','diagnoseDraftStructure'].includes(pending.action) && result?.clipboardRestored !== true && error?.clipboardRestored !== true && error?.attempted !== false) this.cleanupUnconfirmed=true;
    // Paste can change the clipboard before it attempts a keystroke. A
    // definite input refusal therefore cannot stand in for rollback evidence.
    if (pasteCommands.has(pending.action) && !clipboardSettled(error??result,pending.allowClipboardReplacement))this.cleanupUnconfirmed=true;
    if(this.failure||error)pending.reject(this.failure??error);else pending.resolve(result);
    pending.completed();
  }
  fail(error) {
    this.failure ??= error;
    // Even protocol/time-out failures first stop cooperatively. A forced kill
    // cannot establish whether an in-flight clipboard transaction was restored.
    this.close().catch(()=>{});
  }
  request(action, values = {}) {
    if (!['verifyMessageQuote','checkClearMessageQuote','attachMessageQuote','scrollOcrQuoteHistory','openOcrQuoteMenu','captureOcrQuoteMenu','chooseOcrQuoteMenu','bindOcrQuotePreview','capture','captureUiaNavigation','captureUiaControls','captureUiaSearch','warmUiaLocators','prepareUiaBackgroundText','writeUiaBackgroundText','submitUiaBackgroundText','releaseUiaBackgroundText','pasteUiaImage','pasteUiaFile','submitUiaFileDialog','submitUiaImage','resumeUiaImage','openUiaSearch','focusUiaEditor','focusUiaReadyEditor','inspectUiaFocusGeometry','captureLayout','captureLayoutHandoff','captureLayoutRaised','inspectLayout','inspectTargetOcclusion','inspectOcclusion','inspectClipboard','inspectFocusHandoff','inspectFocusActivation','inspectPopup','inspectEmptyEditorPhase','click','movePointer','chord','type','typeText','paste','pasteImage','searchEnter','submitTextEnter','resumeTextEnterProof','readDraft','diagnoseDraftStructure','beginFocusHandoff','parkFocusHandoff','resumeFocusHandoff','transferFocusHandoff','releaseFocusHandoff','restoreTransferredFocus','stop'].includes(action) || !object(values)) return Promise.reject(fault('UI_QT_REQUEST_INVALID'));
    if(action==='stop')return this.close().then(()=>({stopped:true}));
    if (!this.enableInput && !['capture','captureLayout','inspectLayout','warmUiaLocators','inspectUiaFocusGeometry','inspectTargetOcclusion','inspectOcclusion','inspectClipboard','inspectFocusHandoff','inspectFocusActivation','inspectPopup','inspectEmptyEditorPhase','stop'].includes(action)) return Promise.reject(fault('UI_QT_INPUT_DISABLED', { attempted: false }));
    this.start(); if (this.pending) return Promise.reject(fault('UI_QT_BUSY', { attempted: false }));
    const id = ++this.sequence, line = JSON.stringify({ ...values, id, action }) + '\n';
    if (Buffer.byteLength(line) > 65536) return Promise.reject(fault('UI_QT_REQUEST_INVALID', { attempted: false }));
    return new Promise((resolve,reject) => {
      let completed;const completion=new Promise(done=>{completed=done;});
      const timer=setTimeout(()=>this.fail(fault('UI_QT_TIMEOUT')),this.timeoutMs);
      this.pending={id,action,timer,resolve,reject,completion,completed,allowClipboardReplacement:pasteCommands.has(action)&&values.allowClipboardReplacement===true};
      try{this.child.stdin.write(line);}catch{this.fail(fault('UI_QT_PIPE_FAILED'));}
    });
  }
  close() {
    if(this.closePromise)return this.closePromise;
    this.closed=true;
    if(!this.child)return this.closePromise=Promise.resolve({processStopped:true});
    const active=this.pending;if(active)clearTimeout(active.timer);
    this.closePromise=Promise.resolve().then(async()=>{
      let timer;
      try{
        if(!this.exitResult){
          this.stopId=++this.sequence;
          try{this.child.stdin.write(JSON.stringify({id:this.stopId,action:'stop'})+'\n');}
          catch{this.failure??=fault('UI_QT_PIPE_FAILED');}
        }
        const [exit]=await Promise.race([
          Promise.all([this.exitPromise,active?.completion??Promise.resolve()]),
          new Promise((_,reject)=>{timer=setTimeout(()=>{
            this.cleanupUnconfirmed=true;this.finishPending(fault('UI_QT_CLEANUP_UNCONFIRMED'));
            try{this.child.kill();}catch{}
            reject(fault('UI_QT_CLEANUP_UNCONFIRMED'));
          },this.closeTimeoutMs);}),
        ]);
        if(exit.code!==0||exit.signal||!this.stopAcknowledged||this.cleanupUnconfirmed)throw fault('UI_QT_CLEANUP_UNCONFIRMED');
        return {processStopped:true};
      }finally{clearTimeout(timer);}
    });
    return this.closePromise;
  }
  waitExited() { return this.close(); }
  release() { return this.close(); }
}

/** prepare() performs navigation; shared focus-handoff keeps only input intent.
 * observe() is passive; UiTextOutbox never injects keys while observing. */
export class QtVisualDriver {
  #completedTextNavigation = null;
  constructor({ root, config, client, clientFactory, allowSubmit = false, allowBackgroundText = false, allowClipboardReplacement = false, receipt, resolveTarget, verifyControls, controlVerificationPolicy='all-operations', navigationPolicy='pixels-v1', probeAccount = probeAccountBinding, verifyContact = contactIdentity, recognize = recognizeImage, locateContactPanel = async options=>(await import('./qt-auto-layout.mjs')).locateQtContactPanel(options), verifyPanelClosed = async options=>(await import('./qt-auto-layout.mjs')).verifyQtContactPanelClosed(options), locateMainTitle = async options=>(await import('./qt-auto-layout.mjs')).locateQtMainTitle(options), inspectPanelEditor = async options=>(await import('./qt-auto-layout.mjs')).inspectQtPanelEditor(options), locateSearchPopup = async ({root,signal,...input})=>(await import('./qt-auto-layout.mjs')).runQtLayoutPython({root,signal,script:'qt-auto-layout-image.py',input:{...input,version:1,mode:'search-popup'}}), warmOcr = recognize === recognizeImage ? warmLocalOcr : async()=>{}, wait = ms => new Promise(resolve => setTimeout(resolve,ms)), now = Date.now }) {
    this.root = path.resolve(root); this.config = validateQtConfig(config);
    if (!client || typeof client.request !== 'function' || typeof allowSubmit !== 'boolean' || typeof allowBackgroundText !== 'boolean' || typeof allowClipboardReplacement !== 'boolean' || allowSubmit && typeof receipt !== 'function') throw fault('UI_QT_DRIVER_OPTIONS_INVALID');
    if(typeof warmOcr!=='function'||typeof locateContactPanel!=='function'||typeof verifyPanelClosed!=='function'||typeof locateSearchPopup!=='function'||typeof locateMainTitle!=='function'||typeof inspectPanelEditor!=='function')throw fault('UI_QT_DRIVER_OPTIONS_INVALID');
    if(verifyControls!==undefined&&typeof verifyControls!=='function')throw fault('UI_QT_DRIVER_OPTIONS_INVALID');
    if(!['all-operations','input-boundaries-v1'].includes(controlVerificationPolicy)||controlVerificationPolicy==='input-boundaries-v1'&&typeof verifyControls!=='function')throw fault('UI_QT_CONTROLS_POLICY_INVALID');
    this.controlVerificationPolicy=controlVerificationPolicy;
    if(!['pixels-v1','uia-controls-v1'].includes(navigationPolicy)||navigationPolicy==='uia-controls-v1'&&typeof verifyControls!=='function')throw fault('UI_QT_DRIVER_OPTIONS_INVALID');
    this.navigationPolicy=navigationPolicy;
    if(this.config.layoutMode==='uia-v1'&&(navigationPolicy!=='uia-controls-v1'||controlVerificationPolicy!=='input-boundaries-v1'))throw fault('UI_QT_CONTROLS_POLICY_INVALID');
    Object.assign(this, { client,allowSubmit,allowBackgroundText,allowClipboardReplacement,receiptProvider:receipt,probeAccount,verifyContact,verifyControls,recognize,locateContactPanel,verifyPanelClosed,locateSearchPopup,locateMainTitle,inspectPanelEditor,warmOcr,wait,now });
    this.clientFactory = clientFactory ?? (() => new QtActionsClient({root:this.root,config:this.config,enableInput:client.enableInput === true}));
    this.resolveTarget = resolveTarget ?? (async (job,{signal}={}) => { const result = await readSelectableContacts({ root:this.root,expectedAccountRef:this.config.accountRef,targetWxids:[job.target],signal }); return result.contacts.find(contact => contact.wechatId === job.target); });
    this.current = null; this.frame = null; this.transaction = null; this.busy = false; this.closed = false; this.draftHold = null;
    this.surface = 'main';
  }
  checkJob(job) { if (this.closed || !object(job) || job.account !== this.config.account || !id(job.target) || job.target === job.account || job.target === 'filehelper') throw fault('UI_QT_PRIVATE_TARGET_REQUIRED'); }
  active() { if(this.closed)throw fault('UI_QT_CLOSED');if(this.operationSignal?.aborted)throw fault('UI_QT_CANCELLED'); }
  async verifyControlBinding(job,frame,operation,signal=this.operationSignal,{navigationReadiness,allowLayoutRefresh=false}={}){
    if(!this.verifyControls)return;
    const config=structuredClone(this.config),binding=structuredClone(frame?.binding),transaction=structuredClone(this.transaction);
    const identity={id:job.id,account:job.account,target:job.target,...(job.mode?{mode:job.mode}:{})};
    try{
      this.active();if(signal?.aborted)throw fault('UI_QT_CANCELLED');this.assertTransaction(frame);
      // The real UIA provider already resolved roles before navigation. This
      // explicit policy defers its next fresh check to actual input; it does
      // not supply a cached or fabricated verification result.
      if(operation==='prepare'&&this.controlVerificationPolicy==='input-boundaries-v1')return;
      if(allowLayoutRefresh&&(operation!=='navigation-ready'||this.config.layoutMode!=='uia-v1'||!positiveDecimal(navigationReadiness?.searchPopupHwnd)))throw fault('UI_QT_CONTROLS_UNVERIFIED');
      const result=await this.verifyControls({root:this.root,config:structuredClone(config),job:structuredClone(identity),binding:structuredClone(binding),signal,operation,...(navigationReadiness?{navigationReadiness:structuredClone(navigationReadiness)}:{}),...(allowLayoutRefresh?{allowLayoutRefresh:true}:{})});
      this.active();if(signal?.aborted)throw fault('UI_QT_CANCELLED');
      if(result?.verified!==true||result.proof!=='uia-controls-v1')throw fault('UI_QT_CONTROLS_UNVERIFIED');
      if(result.conversationFingerprint!==undefined&&!validConversationFingerprint(result.conversationFingerprint))throw fault('UI_QT_CONTROLS_UNVERIFIED');
      if(!isDeepStrictEqual(this.config,config)||!isDeepStrictEqual(frame.binding,binding)||!isDeepStrictEqual(this.transaction,transaction)||job.id!==identity.id||job.account!==identity.account||job.target!==identity.target)throw fault('UI_QT_CONTROLS_BINDING_CHANGED');
      this.assertTransaction(frame);
      if(this.current?.jobId===job.id){
        if(this.current.uiaConversationFingerprint&&(!validConversationFingerprint(result.conversationFingerprint)||!isDeepStrictEqual(this.current.uiaConversationFingerprint,result.conversationFingerprint)))throw fault('UI_QT_HEADER_CHANGED');
        if(result.conversationFingerprint)this.current.uiaConversationFingerprint=structuredClone(result.conversationFingerprint);
      }
      return result;
    }catch(error){
      // Read-only verification precedes the next native input. Keep any owned
      // draft checkpoint, but return borrowed text/image focus on refusal.
      // Voice preparation owns a separate lease and releases it in its catch.
      const hadTextLease=!!this.textFocusLease,hadVoiceLease=!!this.voiceFocusLease;let returned;
      try{returned=await this.releaseTextFocus();}catch(cleanup){cleanup.controlsCleanupFailed=true;throw cleanup;}
      const wrapped=fault(/^(?:UI_QT|UIA_MODE)_[A-Z0-9_]{1,70}$/.test(error?.code??'')?error.code:'UI_QT_CONTROLS_UNVERIFIED',{attempted:false,...(/^UI_CONTROLS_[A-Z0-9_]{1,70}$/.test(error?.nativeReason??'')?{nativeReason:error.nativeReason}:{}),...(error?.code==='UIA_MODE_VERIFIER_CLEANUP_UNCONFIRMED'?{controlsCleanupFailed:true}:{})});
      throw markUiaVerificationRefusal(wrapped,operation,{hadTextLease,hadVoiceLease,returned});
    }
  }
  focusActivation(){if(this.config.layoutMode==='uia-v1')return{uiaCaptionActivation:true};const l=this.config.layout;
    if(l.focusActivateRect)return{focusActivation:{rect:l.focusActivateRect,rgbaSha256:l.focusActivateRgbaSha256}};
    const activation={rect:l.pointerParkRect,mode:'blank-caption-v1'};
    // Adaptive layouts already locate this blank caption patch. The native
    // fallback raises the bound window without focus, observes its current
    // inactive pixels, then clicks once; no inactive manual calibration.
    return observedLayout(this.config)&&validFocusActivation(activation,l.width)?{focusActivation:activation}:{};
  }
  preparationLease(){return this.voiceFocusLease??this.textFocusLease;}
  addForegroundInterval(interval){
    const values=sanitizeForegroundIntervals([interval],{phases:['contact-navigation','preparation'],maxCount:1});
    if(!values){this.foregroundIntervalsInvalid=true;return;}
    this.foregroundIntervals??=[];this.foregroundIntervals.push(...values);
    if(this.foregroundIntervals.length>30)this.foregroundIntervalsInvalid=true;
  }
  completedForegroundIntervals(){return this.foregroundIntervalsInvalid?undefined:sanitizeForegroundIntervals(this.foregroundIntervals??[],{phases:['contact-navigation','preparation'],maxCount:30});}
  async withPreparationFocusParked(task,{includesContactNavigation=false}={}){
    const lease=this.preparationLease();
    if(!lease)return task();
    if(lease.parked||this.surface!=='main')throw fault('UI_QT_FOCUS_SEGMENT_INVALID');
    const checkpoint=await this.capture(['header']);this.active();
    const parked=await lease.owner.request('parkFocusHandoff');
    if(parked?.parked!==true||parked.restored!==true||parked.skipped!==false)throw fault('UI_QT_FOCUS_RETURN_UNCONFIRMED',focusReturnDiagnostics(parked));
    lease.parked=true;this.frame=null;this.addForegroundInterval(parked.foregroundInterval);
    // Do not reacquire focus when background work fails or is cancelled. Native
    // release/stop can retire a parked lease without another foreground action.
    // A real usable return interval, even when the background task is empty or
    // cached. Work overlaps the minimum gap; native still rejects any human
    // activity during it instead of immediately borrowing focus back.
    const [value]=await Promise.all([task(),this.wait(250)]);this.active();
    const resumed=await lease.owner.request('resumeFocusHandoff',{includesContactNavigation});
    const uia=lease.uiaMode===true;
    if(resumed?.resumed!==true||!validFocusHandoff(lease.handoff)||!validFocusHandoff(resumed.focusHandoff)||JSON.stringify(resumed.focusHandoff.returnWindow)!==JSON.stringify(lease.handoff.returnWindow)||uia!==(this.config.layoutMode==='uia-v1'))throw fault('UI_QT_FOCUS_LEASE_INVALID');
    if(uia){
      if([lease.handoff.activation,resumed.focusHandoff.activation].some(value=>value!==undefined&&value.mode!=='uia-caption-v1'))throw fault('UI_QT_FOCUS_LEASE_INVALID');
      lease.handoff=structuredClone(resumed.focusHandoff);
    }else if(JSON.stringify(resumed.focusHandoff.activation)!==JSON.stringify(lease.handoff.activation))throw fault('UI_QT_FOCUS_LEASE_INVALID');
    lease.parked=false;this.frame=null;
    // Keep the original transaction. The next capture must still match its
    // epoch/revision/process; activity while parked is never silently accepted.
    const current=await this.capture(['header']);
    if(current.regions[0]?.rgbaSha256!==checkpoint.regions[0]?.rgbaSha256)throw fault('UI_QT_HEADER_CHANGED');
    return value;
  }
  async warmRecognition(signal){
    if(this.closed||signal?.aborted)throw fault(this.closed?'UI_QT_CLOSED':'UI_QT_CANCELLED');
    if(this.config.ocrBackend==='rapidocr')await Promise.all(['small','medium'].map(model=>this.warmOcr({model,signal})));
    if(this.closed||signal?.aborted)throw fault(this.closed?'UI_QT_CLOSED':'UI_QT_CANCELLED');
  }
  async lookupTarget(job,{signal}={}){
    this.checkJob(job);if(signal?.aborted)throw fault('UI_QT_CANCELLED');
    const account=job.account,target=job.target,accountRef=this.config.accountRef;
    const uniqueNameLookup=(name,searchKind)=>{
      const titleSha256=crypto.createHash('sha256').update(name).digest('hex');
      return Object.freeze({account,target,accountRef,displayedId:name,searchKind,...(this.config.layoutMode==='uia-v1'?{uiaTarget:Object.freeze({version:1,proof:'database-unique-display-name-v1',titleSha256,querySha256:titleSha256})}:{})});
    };
    const contact=await this.resolveTarget(job,{signal});
    this.checkJob(job);if(signal?.aborted)throw fault('UI_QT_CANCELLED');
    if(job.account!==account||job.target!==target||this.config.accountRef!==accountRef)throw fault('UI_QT_TARGET_CHANGED');
    if(target.endsWith('@chatroom')){
      // A room ID is not a searchable WeChat ID. The fresh database catalog
      // must establish one unique title across rooms and private contacts.
      if(!observedLayout(this.config))throw fault('UI_QT_GROUP_ADAPTIVE_LAYOUT_REQUIRED');
      if(!object(contact)||contact.wechatId!==target||contact.kind!=='group'||contact.ambiguous!==false||contact.uniqueSearchName!==true||
        typeof contact.groupName!=='string'||contact.groupName!==contact.name||contact.groupName.length<1||contact.groupName.length>128||
        contact.groupName!==contact.groupName.trim()||/[\u0000-\u001f\u007f]/u.test(contact.groupName)||contact.groupName.endsWith('@chatroom'))throw fault('UI_QT_GROUP_SEARCH_NAME_REQUIRED');
      return uniqueNameLookup(contact.groupName,'group-title');
    }
    if(!object(contact)||contact.wechatId!==target||contact.ambiguous!==false)throw fault('UI_QT_TARGET_ALIAS_REQUIRED');
    const displayedId=alias(contact.alias)?contact.alias:alias(target)&&!target.startsWith('wxid_')?target:null;
    if(!displayedId||this.config.layoutMode==='uia-v1'&&contact.uniqueSearchName===true){
      // The internal wxid identifies database rows, but is not necessarily a
      // searchable public WeChat ID. Use a database-proven unique remark or
      // nickname while retaining the stable ID for delivery and receipts.
      const name=contact.searchName;
      if(!observedLayout(this.config)||contact.uniqueSearchName!==true||typeof name!=='string'||name.length<1||name.length>128||name!==name.trim()||!name.isWellFormed()||/[\u0000-\u001f\u007f]/u.test(name)||name.endsWith('@chatroom'))throw fault('UI_QT_TARGET_SEARCH_NAME_REQUIRED');
      return uniqueNameLookup(name,'private-name');
    }
    // Shared mode uses this exact database mapping for direct query selection;
    // it never replaces the fresh account/process binding.
    if(this.config.layoutMode==='uia-v1'){
      const name=contact.name;
      if(typeof name!=='string'||name.length<1||name.length>256||!name.isWellFormed()||/[\u0000-\u001f\u007f]/u.test(name))throw fault('UI_QT_TARGET_SEARCH_NAME_REQUIRED');
      // Preserve the shared sender's exact database alias -> search Enter
      // route. A nonunique display title can confirm that transition, but can
      // never authorize the current-chat shortcut on its own.
      return Object.freeze({account,target,accountRef,displayedId,uiaTarget:Object.freeze({version:1,proof:'database-exact-alias-v1',titleSha256:crypto.createHash('sha256').update(name).digest('hex'),querySha256:crypto.createHash('sha256').update(displayedId).digest('hex')})});
    }
    return Object.freeze({account,target,accountRef,displayedId});
  }
  assertTransaction(frame) {
    const metadata=frame?.observationKind==='uia-metadata-v1';
    if(metadata?(frame.pixelsRead!==false||frame.pixelFormat!==undefined||frame.image!=null||this.navigationPolicy!=='uia-controls-v1'):frame?.pixelFormat!=='rgba-row-major-opaque-v1')throw fault('UI_QT_NATIVE_UPDATE_REQUIRED');
    const binding = frame?.binding, layout = this.config.layout, surface = this.surface === 'profile' ? this.config.profileSurface : this.surface === 'self' ? this.config.selfSurface : null,observed=observedLayout(this.config)&&surface?frame.popup?.clientRect:null;
    if (!object(binding) || !surface && this.config.hwnd !== 'auto' && binding.hwnd !== this.config.hwnd || !/^[1-9][0-9]{0,18}$/.test(binding.hwnd ?? '') || binding.foreground !== true || !Number.isSafeInteger(binding.pid) || !/^[1-9][0-9]{0,18}$/.test(binding.processCreatedFileTimeUtc ?? '') ||
        binding.dpi !== layout.dpi || binding.clientRect?.right !== (observed?.right??surface?.width ?? layout.width) || binding.clientRect?.bottom !== (observed?.bottom??surface?.height ?? layout.height) || binding.clientRect?.left !== 0 || binding.clientRect?.top !== 0 ||
        !Number.isSafeInteger(frame.revision) || frame.revision < 0 || !Number.isFinite(frame.idleMs) || frame.idleMs < 0 || !/^[a-f0-9]{32}$/.test(frame.epoch ?? '') || !/^[a-f0-9]{32}$/.test(frame.token ?? '') ||
        !Array.isArray(frame.regions) || frame.regions.some(item => !rect(item.rect) || (metadata?(!['header','editor','search','send'].includes(item.role)||!hash(item.controlSha256)||item.rgbaSha256!==undefined):!hash(item.rgbaSha256)))) throw fault('UI_QT_OBSERVATION_INVALID');
    if (this.transaction && (frame.epoch !== this.transaction.epoch || frame.revision !== this.transaction.revision || binding.pid !== this.transaction.pid || binding.processCreatedFileTimeUtc !== this.transaction.created)) throw fault('UI_QT_HUMAN_ACTIVITY_CHANGED');
  }
  regionDigest(frame,index=0){return frame?.observationKind==='uia-metadata-v1'?frame.regions?.[index]?.controlSha256:frame?.regions?.[index]?.rgbaSha256;}
  uiaOffscreenSearchFrame(frame){
    const p=frame?.popup,b=frame?.binding,c=p?.clientRect,a=p?.clientRectInRoot,w=p?.windowRect;
    const signed=value=>object(value)&&Object.keys(value).length===4&&['left','top','right','bottom'].every(key=>Number.isSafeInteger(value[key])&&Math.abs(value[key])<=65536)&&value.right>value.left&&value.bottom>value.top;
    if(this.config.layoutMode!=='uia-v1'||this.navigationPolicy!=='uia-controls-v1'||frame?.observationKind!=='uia-metadata-v1'||frame.pixelsRead!==false||p?.offscreenSearch!==true||p.surfaceId!=='search'||p.kind!=='search'||p.ownerRelation!=='root-owned'||p.geometryMode!=='observed-v1'||p.stableObservations!==2||!positiveDecimal(p.hwnd)||p.hwnd===b?.hwnd||p.dpi!==b?.dpi||!rect(c)||c.left!==0||c.top!==0||c.right<20||c.bottom<20||!signed(a)||!signed(w)||!signed(b?.captureRect)||!rect(b?.clientRect)||c.right>b.clientRect.right||c.bottom>b.clientRect.bottom)return false;
    const screen={left:b.captureRect.left+a.left,top:b.captureRect.top+a.top,right:b.captureRect.left+a.right,bottom:b.captureRect.top+a.bottom};
    return b.clientRect.left===0&&b.clientRect.top===0&&a.right-a.left===c.right&&a.bottom-a.top===c.bottom&&w.right-w.left<=b.clientRect.right&&w.bottom-w.top<=b.clientRect.bottom&&inside(w,screen)&&frame.regions?.length===1&&frame.regions[0].role==='search'&&rect(frame.regions[0].rect)&&inside(b.clientRect,frame.regions[0].rect);
  }
  uiaOffscreenPopupMargins(frame){const p=frame.popup,w=p.windowRect,a=p.clientRectInRoot,b=frame.binding.captureRect;return[a.left+b.left-w.left,a.top+b.top-w.top,w.right-a.right-b.left,w.bottom-a.bottom-b.top];}
  region(name) { if(name==='search'&&this.surface==='search'&&this.config.layoutMode==='uia-v1'&&this.uiaSearchRegion)return this.uiaSearchRegion.rect;if(observedLayout(this.config)&&['profileAlias','selfAlias','searchResultIdentity'].includes(name)){const area=this.observedPopupAreas?.[this.surface];if(!rect(area))throw fault('UI_QT_POPUP_OBSERVATION_REQUIRED');return area;}const surface=this.surface==='profile'?this.config.profileSurface:this.surface==='self'?this.config.selfSurface:null;return surface&&['profileAlias','selfAlias'].includes(name)?surface.alias:surface&&['profileClose','selfClose'].includes(name)?surface.close:this.config.layout[name]; }
  popupCalibration(surface=this.surface){return surface==='search'?this.config.searchPopupCalibration:surface==='self'?this.config.selfSurface?.popupCalibration:surface==='profile'?this.config.profileSurface?.popupCalibration:null;}
  popupTransition(surface){const calibration=this.popupCalibration(surface),adaptive=observedLayout(this.config);if(surface==='search')this.uiaSearchRegion=null;if(adaptive){this.observedPopupAreas??={};delete this.observedPopupAreas[surface];}return calibration?{popupTransition:{id:surface,calibration:adaptive?toObservedPopupCalibration(calibration,surface==='search'?'search':'profile'):calibration,...(adaptive?{geometryMode:'observed-v1'}:{})}}:{};}
  async capture(names = ['header'], image = false, { retryPixelChanges = true } = {}) {
    this.active();
    const uia=this.config.layoutMode==='uia-v1'&&this.navigationPolicy==='uia-controls-v1';
    if(uia&&this.surface==='main'&&names.length===1&&names[0]==='header'&&!image)return this.captureUiaNavigation();
    if(uia&&(image||!(this.surface==='main'&&names.join(',')==='header,editor'||this.surface==='search'&&names.join(',')==='search')))throw fault('UI_QT_CONTROLS_POLICY_INVALID');
    const calibration=this.popupCalibration(),adaptive=observedLayout(this.config)&&Boolean(calibration);
    const request={ regions: names.map(name => typeof name==='string'?this.region(name):name), image, surface:calibration?`${adaptive?'observed':'calibrated'}-${this.surface==='search'?'search':'profile'}`:this.surface==='main'?'main':'owned-profile',...(calibration?{surfaceId:this.surface}:{}) };
    let frame;
    for(let attempt=0;;attempt++){
      try{frame=await this.client.request(uia?(this.surface==='search'?'captureUiaSearch':'captureUiaControls'):'capture',request);break;}
      catch(error){
        // A caret may blink between the two reads of a read-only screenshot.
        // Retry only that observation; never repeat a keyboard/mouse action or
        // an account, activity, focus or clipboard failure.
        if(!retryPixelChanges||error?.code!=='QT_PIXELS_CHANGED'||attempt>=3)throw error;
        await this.wait(25);this.active();
      }
    }
    if(calibration&&(!object(frame.popup)||frame.popup.surfaceId!==this.surface||frame.popup.kind!==calibration.kind||frame.popup.ownerRelation!==calibration.ownerRelation||frame.popup.stableObservations!==2||!positiveDecimal(frame.popup.hwnd)||(this.surface==='search'?frame.popup.hwnd===frame.binding?.hwnd:frame.popup.hwnd!==frame.binding?.hwnd)))throw fault('UI_QT_POPUP_BINDING_INVALID');
    if(adaptive){const p=frame.popup,client=p?.clientRect,rootArea=p?.clientRectInRoot,window=p?.windowRect,offscreen=this.uiaOffscreenSearchFrame(frame);
      const signedRect=value=>object(value)&&Object.keys(value).length===4&&['left','top','right','bottom'].every(key=>Number.isSafeInteger(value[key])&&Math.abs(value[key])<=65536)&&value.right>value.left&&value.bottom>value.top;
      if(p.offscreenSearch!==undefined&&!offscreen||p.geometryMode!=='observed-v1'||p.dpi!==this.config.layout.dpi||!rect(client)||client.left!==0||client.top!==0||client.right<20||client.bottom<20||client.right>4096||client.bottom>4096||client.right*client.bottom>12000000||!signedRect(window)||!signedRect(rootArea)||rootArea.right-rootArea.left!==client.right||rootArea.bottom-rootArea.top!==client.bottom||this.surface==='search'&&!offscreen&&!inside({left:0,top:0,right:this.config.layout.width,bottom:this.config.layout.height},rootArea))throw fault('UI_QT_POPUP_BINDING_INVALID');
      this.observedPopupAreas??={};this.observedPopupAreas[this.surface]=this.surface==='search'?structuredClone(rootArea):structuredClone(client);
      if(names.length===0&&(frame.regions?.length!==1||!sameRect(frame.regions[0].rect,this.observedPopupAreas[this.surface])))throw fault('UI_QT_POPUP_BINDING_INVALID');
    }
    this.active();this.assertTransaction(frame);
    if(uia&&this.surface==='search'){
      if(frame.observationKind!=='uia-metadata-v1'||frame.pixelsRead!==false||frame.regions.length!==1||frame.regions[0].role!=='search'||!inside(frame.binding.clientRect,frame.regions[0].rect))throw fault('UI_QT_POPUP_BINDING_INVALID');
      this.uiaSearchRegion={popupHwnd:frame.popup.hwnd,rect:structuredClone(frame.regions[0].rect)};
    }
    this.frame = frame; return frame;
  }
  uiaNavigationElapsed(context){return Math.max(this.now()-context.started,context.waited);}
  async captureUiaNavigation(){
    this.active();
    if(this.navigationPolicy!=='uia-controls-v1'||this.surface!=='main'||!this.preparationLease()||this.preparationLease().parked)throw fault('UI_QT_CONTROLS_UNVERIFIED');
    const frame=await this.client.request('captureUiaNavigation',{surface:'main',regions:[this.config.layout.header],image:false});
    this.active();this.assertTransaction(frame);
    if(frame.inputSent!==false||frame.observationKind!=='uia-metadata-v1'||frame.pixelsRead!==false||frame.baselinePixelStable!==false||frame.navigationOnly!==true||frame.popup||frame.regions.length!==1||frame.regions[0].role!=='header'||!sameRect(frame.regions[0].rect,this.config.layout.header))throw fault('UI_QT_OBSERVATION_INVALID');
    this.frame=frame;return frame;
  }
  assertUiaInitialHeader(context,frame){
    this.active();
    if(this.preparationLease()!==context.lease||context.lease.parked||this.surface!=='main')throw fault('UI_QT_OBSERVATION_CHANGED');
    if(this.uiaNavigationElapsed(context)>400)throw fault('UI_QT_INITIAL_HEADER_UNSTABLE');
    if(!frame)return;
    if(frame.idleMs<this.config.idleMs)throw fault('UI_USER_ACTIVE');
    if(frame.popup||frame.regions.length!==1||!sameRect(frame.regions[0].rect,this.config.layout.header))throw fault('UI_QT_OBSERVATION_CHANGED');
    const baseline=context.baseline;
    if(baseline&&(frame.epoch!==baseline.epoch||frame.revision!==baseline.revision||!['hwnd','pid','threadId','processCreatedFileTimeUtc','dpi','lastInputTick','focusHwnd'].every(key=>frame.binding[key]===baseline.binding[key])||!['clientRect','captureRect'].every(key=>sameRect(frame.binding[key],baseline.binding[key]))))throw fault('UI_QT_OBSERVATION_CHANGED');
    context.baseline??=structuredClone(frame);
  }
  async waitUiaInitialHeader(context){
    this.assertUiaInitialHeader(context);
    if(this.uiaNavigationElapsed(context)+35>400)throw fault('UI_QT_INITIAL_HEADER_UNSTABLE');
    await this.wait(35);context.waited+=35;this.assertUiaInitialHeader(context);
  }
  async stableUiaInitialHeader(lease,{context={lease,started:this.now(),waited:0},firstOnly=false}={}) {
    let previous,backoff=false;
    for(let index=0;index<25;index++){
      if(backoff){await this.waitUiaInitialHeader(context);backoff=false;}
      this.assertUiaInitialHeader(context);
      let frame;
      try{frame=await this.capture(['header'],false,{retryPixelChanges:false});}
      catch(error){const mismatch=pixelMismatchDiagnostic(error?.pixelMismatch);
        if(error?.code!=='QT_PIXELS_CHANGED'||error.attempted!==false||mismatch?.stage!=='capture'||mismatch.anchorIndex!==0)throw error;
        previous=null;backoff=true;continue;
      }
      this.assertUiaInitialHeader(context,frame);
      // Native capture already compares two pixel reads. Fresh navigation can
      // consume its first valid token; only a rejected cached-chat candidate
      // retains the conservative consecutive-observation fallback.
      if(firstOnly||previous===frame.regions[0].rgbaSha256)return frame;
      // Stable controls incur no scheduled delay. Only observed redraw gets a
      // bounded read-only backoff; the subsequent native input guard is intact.
      if(previous!==undefined&&previous!==null)backoff=true;
      previous=frame.regions[0].rgbaSha256;
    }
    throw fault('UI_QT_INITIAL_HEADER_UNSTABLE');
  }
  async openUiaSearch(frame,context){
    if(frame.navigationOnly===true){
      this.assertUiaInitialHeader(context,frame);await context.validateAccount?.(frame);this.assertUiaInitialHeader(context,frame);
      const result=await this.sharedAction('openUiaSearch',this.popupTransition('search'),['header'],frame);
      if(result.openedSearch!==true||result.navigationOnly!==true||result.baselinePixelStable!==false)throw fault('UI_QT_SEARCH_ENTER_UNCERTAIN');
      return frame;
    }
    for(;;){
      this.assertUiaInitialHeader(context,frame);
      await context.validateAccount?.(frame);
      this.assertUiaInitialHeader(context,frame);
      try{
        await this.sharedAction('chord',{key:'Control+F',...this.popupTransition('search')},['header'],frame);
        // This exact frame is the transition baseline, including any redraw
        // observed before the first successfully executed navigation input.
        return frame;
      }catch(error){
        const mismatch=pixelMismatchDiagnostic(error?.pixelMismatch);
        if(error?.code!=='QT_PIXELS_CHANGED'||error.attempted!==false||mismatch?.stage!=='guard'||mismatch.anchorIndex!==0)throw error;
        // QtGuard rejected the header before preparing a popup or calling
        // SendInput. No other input, ambiguous result or resume may repeat.
        await this.waitUiaInitialHeader(context);
        frame=await this.stableUiaInitialHeader(context.lease,{context,firstOnly:true});
      }
    }
  }
  async stableSelfOpenFrame() {
    this.active();
    const baseline=structuredClone(this.frame),layout=this.config.layout;
    if(this.surface!=='main'||!this.transaction)throw fault('UI_QT_OBSERVATION_INVALID');
    this.assertTransaction(baseline);
    const header=baseline.regions.find(region=>sameRect(region.rect,layout.header));
    if(!header)throw fault('UI_QT_OBSERVATION_INVALID');
    const started=this.now();let previous,waited=0,lastMismatch;
    const elapsed=()=>Math.max(this.now()-started,waited);
    // Focus activation can redraw the avatar after a successful screenshot.
    // Observe the complete calibrated header and avatar twice, retaining the
    // original transaction and header. Only failed read-only avatar captures
    // may repeat; the returned token is consumed by exactly one input attempt.
    for(let attempt=0;attempt<12;attempt++){
      if(attempt>0){if(elapsed()+35>400)break;await this.wait(35);waited+=35;this.active();}
      if(elapsed()>400)break;
      let current;
      try{current=await this.capture(['header','selfOpen'],false,{retryPixelChanges:false});}
      catch(error){
        const mismatch=pixelMismatchDiagnostic(error?.pixelMismatch);
        if(error?.code!=='QT_PIXELS_CHANGED'||error.attempted!==false||mismatch?.stage!=='capture'||mismatch?.anchorIndex!==1)throw error;
        previous=null;lastMismatch=error;continue;
      }
      if(current.idleMs<this.config.idleMs)throw fault('UI_USER_ACTIVE');
      if(current.binding.hwnd!==baseline.binding.hwnd||current.binding.dpi!==baseline.binding.dpi||!sameRect(current.binding.clientRect,baseline.binding.clientRect)||!sameRect(current.binding.captureRect,baseline.binding.captureRect))throw fault('UI_QT_OBSERVATION_CHANGED');
      if(current.regions.length!==2||!sameRect(current.regions[0].rect,layout.header)||!sameRect(current.regions[1].rect,layout.selfOpen))throw fault('UI_QT_OBSERVATION_INVALID');
      if(current.regions[0].rgbaSha256!==header.rgbaSha256)throw fault('UI_QT_HEADER_CHANGED');
      if(elapsed()>400)break;
      if(previous&&current.regions[1].rgbaSha256===previous.regions[1].rgbaSha256)return current;
      previous=current;
    }
    throw lastMismatch??fault('QT_PIXELS_CHANGED',{attempted:false,pixelMismatch:{stage:'capture',anchorIndex:1}});
  }
  async settleSearchQueryClick(baseline){
    this.active();const query=this.config.layout.search,lease=this.preparationLease(),popup=baseline?.popup;
    if(!observedLayout(this.config)||this.surface!=='search'||!lease||lease.parked||!this.transaction||popup?.surfaceId!=='search'||popup.kind!=='search'||baseline.regions?.length!==1||!sameRect(baseline.regions[0].rect,query)||query.left<popup.clientRectInRoot.left||query.right>popup.clientRectInRoot.right||query.top+(query.bottom-query.top)/2>=popup.clientRectInRoot.top)throw fault('UI_QT_OBSERVATION_INVALID');
    this.assertTransaction(baseline);
    const started=this.now(),settle=this.config.settleMs??400,observeFor=Math.min(settle,250);let waited=0,previous;
    const elapsed=()=>Math.max(this.now()-started,waited);
    const caretReady=frame=>{const binding=frame.binding,caret=binding.caretRectInClient;return Number.isSafeInteger(binding.threadId)&&binding.threadId>0&&binding.focusHwnd===binding.hwnd&&binding.caretHwnd===binding.hwnd&&binding.focusBelongsToWindow===true&&binding.caretBelongsToWindow===true&&binding.guiFlags===1&&rect(caret)&&Object.keys(caret).length===4&&inside(query,caret)&&caret.bottom<=frame.popup.clientRectInRoot.top;};
    // The real click retains the native one-use QueryClickProof. These reads
    // only qualify a shorter wait; paste still obtains a new native guard.
    for(let index=0;index<8;index++){
      if(index){if(elapsed()+35>observeFor)break;await this.wait(35);waited+=35;}
      this.active();if(this.surface!=='search'||this.preparationLease()!==lease||lease.parked)throw fault('UI_QT_OBSERVATION_CHANGED');
      if(elapsed()>=observeFor)break;
      let current;
      try{current=await this.capture(['search'],false,{retryPixelChanges:false});}
      catch(error){const mismatch=pixelMismatchDiagnostic(error?.pixelMismatch);if(error?.code!=='QT_PIXELS_CHANGED'||error.attempted!==false||mismatch?.stage!=='capture'||mismatch.anchorIndex!==0)throw error;previous=null;continue;}
      if(current.idleMs<this.config.idleMs)throw fault('UI_USER_ACTIVE');
      if(!['hwnd','pid','threadId','processCreatedFileTimeUtc','dpi','focusHwnd'].every(key=>current.binding[key]===baseline.binding[key])||current.binding.focusBelongsToWindow===false||!['clientRect','captureRect'].every(key=>sameRect(current.binding[key],baseline.binding[key]))||current.epoch!==baseline.epoch||current.revision!==baseline.revision||!['hwnd','kind','surfaceId','ownerRelation','geometryMode','dpi','stableObservations'].every(key=>current.popup[key]===popup[key])||!['clientRect','clientRectInRoot','windowRect'].every(key=>sameRect(current.popup[key],popup[key])))throw fault('UI_QT_OBSERVATION_CHANGED');
      if(current.regions.length!==1||!sameRect(current.regions[0].rect,query))throw fault('UI_QT_OBSERVATION_INVALID');
      if(elapsed()>observeFor)break;
      if(caretReady(current)&&previous&&caretReady(previous)&&sameRect(current.binding.caretRectInClient,previous.binding.caretRectInClient)&&current.regions[0].rgbaSha256===previous.regions[0].rgbaSha256)return;
      previous=caretReady(current)?current:null;
    }
    // Missing caret metadata never authorizes the shortcut. Keep the original
    // remaining settle delay, without another click or any input retry.
    const remaining=settle-elapsed();if(remaining>0)await this.wait(remaining);this.active();
  }
  async action(action, values = {}, anchorNames = ['header'], { stabilizeSelfOpen = false, settleSearchQuery = false } = {}) {
    if(stabilizeSelfOpen&&(action!=='click'||this.surface!=='main'||!sameRect(values.rect,this.config.layout.selfOpen)||anchorNames.length!==2||anchorNames[0]!=='header'||anchorNames[1]!=='selfOpen'))throw fault('UI_QT_OBSERVATION_INVALID');
    if(settleSearchQuery&&(stabilizeSelfOpen||action!=='click'||this.surface!=='search'||!observedLayout(this.config)||!this.preparationLease()||this.preparationLease().parked||!sameRect(values.rect,this.config.layout.search)||anchorNames.length!==1||anchorNames[0]!=='search'))throw fault('UI_QT_OBSERVATION_INVALID');
    const frame = stabilizeSelfOpen?await this.stableSelfOpenFrame():await this.capture(anchorNames);
    this.active();
    const result = await this.client.request(action, { ...values, ...(action==='paste'?{allowClipboardReplacement:this.allowClipboardReplacement}:{}), token:frame.token,epoch:frame.epoch,revision:frame.revision,idleMs:this.config.idleMs });
    this.frame = null;
    if (result.revision !== this.transaction.revision) throw fault('UI_QT_HUMAN_ACTIVITY_CHANGED');
    if(settleSearchQuery){if(result.performed!==true||result.attempted!==true)throw fault('UI_QT_INPUT_UNVERIFIED');await this.settleSearchQueryClick(frame);return result;}
    const pasteComplete=action==='paste'&&result.performed===true&&result.attempted===true&&result.pasteVerified===true&&clipboardSettled(result,this.allowClipboardReplacement)&&result.draft===values.expectedText&&(values.replaceSearch!==true||result.searchReplaced===true);
    const pointerComplete=action==='movePointer'&&result.performed===true&&result.attempted===true&&result.pointerParked===true&&result.focusPreserved===true;
    // These replies include actual completion, not only SendInput acceptance.
    // The next action still starts with a new native pixel/focus observation.
    // Popup open/close, click and chord replies have no such UI completion proof.
    const delay=pasteComplete||pointerComplete?0:action==='type'?120:action==='movePointer'?35:this.config.settleMs??400;
    if(delay>0)await this.wait(delay);this.active();return result;
  }
  async profileIdentity(area, expected, username, {close,reopen}={}) {
    const adaptive=observedLayout(this.config),sharedReopen=Boolean(adaptive&&this.preparationLease()&&typeof close==='function'&&typeof reopen==='function'),frame = await this.capture(adaptive?[]:[area], true),profileArea=this.region(area); let imageFile;
    try {
      if (!object(frame.image) || !hash(frame.image.sha256) || typeof frame.image.file !== 'string') throw fault('UI_QT_IMAGE_INVALID');
      imageFile = noLinks(frame.image.file); const expectedDirectory = path.join(this.root,'state/ui-host/qt-frames');
      if (path.dirname(imageFile) !== expectedDirectory || !/^qt-[a-f0-9]{32}\.png$/.test(path.basename(imageFile)) || crypto.createHash('sha256').update(fs.readFileSync(imageFile)).digest('hex') !== frame.image.sha256) throw fault('UI_QT_IMAGE_INVALID');
      // An unconfigured own alias may be displayed as the exact Reader username.
      // It still requires the same process/open-database evidence and exact UI ID.
      const needsContact=!(username===this.config.account&&expected===username);
      // Both reads concern this captured profile. They may overlap, but neither
      // authorizes input alone and the original pixels are rechecked afterward.
      // One fixed source-pixel transform improves narrow gray profile text.
      // It does not change coordinates, supply expected text, retry recognition
      // based on a candidate identity, or relax any character confidence.
      const preprocess=adaptive&&this.config.ocrBackend==='rapidocr'?'gray-gamma-1.6':undefined;
      const verify=async()=>{const [ocr,verified]=await Promise.all([
        this.recognize({ file:imageFile,backend:this.config.ocrBackend,model:'small',...(preprocess?{preprocess}:{}),signal:this.operationSignal }),
        needsContact?this.verifyContact({ root:this.root,expectedAccountRef:this.config.accountRef,query:{ operation:'verify-id',displayedId:expected,expectedUsername:username },signal:this.operationSignal }):Promise.resolve(null),
      ]);
      this.active();
      if (ocr.imageSha256 !== frame.image.sha256 || ocr.preprocess!==preprocess || adaptive&&(ocr.width!==frame.binding.clientRect.right||ocr.height!==frame.binding.clientRect.bottom) || !(adaptive?observedProfileAlias(ocr,profileArea,expected):exactProfileAlias(ocr,profileArea,expected))) throw fault('UI_QT_PROFILE_ID_UNVERIFIED');
      if(needsContact&&(verified?.matched!==true||verified.unique!==true||verified.comparison!=='exact'))throw fault('UI_QT_CONTACT_UNVERIFIED');
      };
      if(this.preparationLease()&&typeof close==='function'&&typeof reopen==='function'){
        await close();await this.withPreparationFocusParked(verify,{includesContactNavigation:true});await reopen();
      }else await verify();
      // Reopening may yield a new HWND but must reproduce the complete proved
      // profile at identical dimensions and pixels before any subsequent input.
      const current = sharedReopen?await this.waitForExactProfileSource(frame):await this.capture(adaptive?[]:[area]);
      if (!sameRect(current.regions[0].rect,frame.regions[0].rect)||current.regions[0].rgbaSha256 !== frame.regions[0].rgbaSha256) throw fault('UI_QT_PROFILE_CHANGED');
      if(sharedReopen)return current;
    } finally { if (imageFile && path.dirname(imageFile) === path.join(this.root,'state/ui-host/qt-frames') && fs.existsSync(imageFile)) fs.unlinkSync(imageFile); }
  }
  async waitForExactProfileSource(source){
    this.active();const surface=this.surface,lease=this.preparationLease();
    if(!observedLayout(this.config)||!['self','profile'].includes(surface)||!lease||lease.parked||!this.transaction||source?.popup?.surfaceId!==surface||source.popup.kind!=='profile'||source.regions?.length!==1||!sameRect(source.regions[0].rect,source.binding?.clientRect))throw fault('UI_QT_OBSERVATION_INVALID');
    this.assertTransaction(source);
    const started=this.now();let waited=0,reopened;
    for(let index=0;index<12;index++){
      if(index){if(Math.max(this.now()-started,waited)+35>400)break;await this.wait(35);waited+=35;}
      this.active();if(this.surface!==surface||this.preparationLease()!==lease||lease.parked)throw fault('UI_QT_OBSERVATION_CHANGED');
      if(Math.max(this.now()-started,waited)>400)break;
      let current;
      try{current=await this.capture([],false,{retryPixelChanges:false});}
      catch(error){const mismatch=pixelMismatchDiagnostic(error?.pixelMismatch);if(error?.code!=='QT_PIXELS_CHANGED'||error.attempted!==false||mismatch?.stage!=='capture'||mismatch.anchorIndex!==0)throw error;continue;}
      if(Math.max(this.now()-started,waited)>400)break;
      if(current.idleMs<this.config.idleMs)throw fault('UI_USER_ACTIVE');
      if(current.epoch!==source.epoch||current.revision!==source.revision||!['pid','threadId','processCreatedFileTimeUtc','dpi'].every(key=>current.binding[key]===source.binding[key])||!['clientRect','captureRect'].every(key=>sameRect(current.binding[key],source.binding[key]))
        ||!['kind','surfaceId','ownerRelation','geometryMode','dpi','stableObservations'].every(key=>current.popup[key]===source.popup[key])||!['clientRect','clientRectInRoot','windowRect'].every(key=>sameRect(current.popup[key],source.popup[key]))||current.regions.length!==1||!sameRect(current.regions[0].rect,source.regions[0].rect))throw fault('UI_QT_PROFILE_CHANGED');
      // Reopening creates its own causally bound native lease. Its HWND may
      // differ from the source, but may never change during these reads.
      if(reopened&&(current.binding.hwnd!==reopened.binding.hwnd||current.popup.hwnd!==reopened.popup.hwnd))throw fault('UI_QT_PROFILE_CHANGED');
      reopened??=structuredClone(current);
      if(current.regions[0].rgbaSha256===source.regions[0].rgbaSha256){
        this.profileReadinessProofs??=new WeakMap();this.profileReadinessProofs.set(current,{surface,lease,serialized:JSON.stringify(current)});return current;
      }
    }
    throw fault('UI_QT_PROFILE_CHANGED');
  }
  consumeVerifiedProfileFrame(frame,surface){
    this.active();const proof=this.profileReadinessProofs?.get(frame);this.profileReadinessProofs?.delete(frame);
    if(!observedLayout(this.config)||this.config[surface+'CloseKey']!=='Escape'||!proof||frame!==this.frame||this.surface!==surface||proof.surface!==surface||this.preparationLease()!==proof.lease||proof.lease.parked||JSON.stringify(frame)!==proof.serialized)throw fault('UI_QT_OBSERVATION_INVALID');
    this.assertTransaction(frame);return frame;
  }
  async closeVerifiedProfile(frame){
    try{
      this.consumeVerifiedProfileFrame(frame,'profile');
      const result=await this.client.request('chord',{key:'Escape',token:frame.token,epoch:frame.epoch,revision:frame.revision,idleMs:this.config.idleMs});
      if(result.revision!==this.transaction.revision)throw fault('UI_QT_HUMAN_ACTIVITY_CHANGED');
      if(result.performed!==true||result.attempted!==true)throw fault('UI_QT_PROFILE_CLOSE_UNVERIFIED');
      await this.wait(this.config.settleMs??400);this.active();
    }catch(error){error[verifiedProfileCloseFailure]=true;throw error;}
    finally{this.frame=null;this.surface='main';}
  }
  async closeObservedSelfProfile(baseline,captured) {
    try{await this.sendObservedPopupEscape(baseline,'self',captured);return await this.observeMainAfterPopupEscape(baseline,'self');}
    catch(error){if(captured)error[verifiedProfileCloseFailure]=true;throw error;}
  }
  async closeObservedSearch(baseline) { return this.closeObservedPopupWithEscape(baseline,'search'); }
  async closeObservedPopupWithEscape(baseline,surface) {
    await this.sendObservedPopupEscape(baseline,surface);
    return this.observeMainAfterPopupEscape(baseline,surface);
  }
  async sendObservedPopupEscape(baseline,surface,captured) {
    this.active();
    if(!['self','search'].includes(surface)||!observedLayout(this.config)||this.surface!==surface||surface==='self'&&this.config.selfCloseKey!=='Escape'||!this.preparationLease()||!this.transaction)throw fault('UI_QT_OBSERVATION_INVALID');
    const closeCode=surface==='self'?'UI_QT_PROFILE_CLOSE_UNVERIFIED':'UI_QT_SEARCH_CLOSE_UNVERIFIED';
    const layout=this.config.layout,mainHeader=baseline?.regions?.find(entry=>sameRect(entry.rect,layout.header));
    if(!mainHeader||!hash(mainHeader.rgbaSha256)||baseline.epoch!==this.transaction.epoch||baseline.revision!==this.transaction.revision||baseline.binding?.pid!==this.transaction.pid||baseline.binding?.processCreatedFileTimeUtc!==this.transaction.created||baseline.binding?.clientRect?.right!==layout.width||baseline.binding?.clientRect?.bottom!==layout.height)throw fault('UI_QT_OBSERVATION_INVALID');
    if(captured&&surface==='self')this.consumeVerifiedProfileFrame(captured,'self');
    else if(captured&&(surface!=='search'||captured!==this.frame))throw fault('UI_QT_OBSERVATION_INVALID');
    const popup=captured??await this.capture([surface==='self'?'selfAlias':'searchResultIdentity'],false,{retryPixelChanges:false});this.active();this.assertTransaction(popup);
    let result;
    try{result=await this.client.request('chord',{key:'Escape',token:popup.token,epoch:popup.epoch,revision:popup.revision,idleMs:this.config.idleMs});}
    finally{this.frame=null;this.surface='main';}
    if(result.revision!==this.transaction.revision)throw fault('UI_QT_HUMAN_ACTIVITY_CHANGED');
    if(result.performed!==true||result.attempted!==true)throw fault(closeCode);
  }
  async observeMainAfterPopupEscape(baseline,surface){
    const layout=this.config.layout,mainHeader=baseline.regions.find(entry=>sameRect(entry.rect,layout.header));
    const closeCode=surface==='self'?'UI_QT_PROFILE_CLOSE_UNVERIFIED':'UI_QT_SEARCH_CLOSE_UNVERIFIED';
    // The successful key reply is not completion evidence. Two fresh native
    // main-window observations replace only the old fixed post-Escape wait.
    // Full header/editor pixels, original identity/geometry and activity stay
    // guarded. Escape can return before main-window activation is delivered.
    // Only that failed read-only observation may repeat; no input is repeated
    // and no new activity epoch is accepted while awaiting the original main.
    const started=this.now();let previous,waited=0,lastFocusFailure;
    const elapsed=()=>Math.max(this.now()-started,waited);
    for(let index=0;index<12;index++){
      if(index){if(elapsed()+35>400)break;await this.wait(35);waited+=35;}this.active();
      if(elapsed()>400)break;
      let current;
      try{current=await this.capture(['header','editor'],false,{retryPixelChanges:false});}
      catch(error){
        // Search Escape can complete before its visible popup has left the
        // desktop. A refused read grants nothing: repeat the native full
        // visibility check, never ignore an overlap or send another Escape.
        if(error.attempted!==false||error.code!=='DRAFT_WINDOW_NOT_FOREGROUND'&&!(surface==='search'&&error.code==='QT_WINDOW_OBSCURED'))throw error;
        lastFocusFailure=error;previous=null;continue;
      }
      if(elapsed()>400)break;
      if(current.idleMs<this.config.idleMs)throw fault('UI_USER_ACTIVE');
      if(current.binding.hwnd!==baseline.binding.hwnd||current.binding.dpi!==baseline.binding.dpi||surface==='search'&&current.binding.threadId!==baseline.binding.threadId||!sameRect(current.binding.clientRect,baseline.binding.clientRect)||!sameRect(current.binding.captureRect,baseline.binding.captureRect))throw fault('UI_QT_OBSERVATION_CHANGED');
      if(current.regions.length!==2||!sameRect(current.regions[0].rect,layout.header)||!sameRect(current.regions[1].rect,layout.editor))throw fault('UI_QT_OBSERVATION_INVALID');
      if(current.regions[0].rgbaSha256!==mainHeader.rgbaSha256)throw fault('UI_QT_HEADER_CHANGED');
      if(previous){if(current.regions[1].rgbaSha256===previous.regions[1].rgbaSha256)return current;if(surface==='self')throw fault(closeCode);}
      previous=current;
    }
    throw lastFocusFailure??fault(closeCode);
  }
  searchReadinessState(mainBaseline){
    this.active();if(!observedLayout(this.config)||this.surface!=='search'||!this.preparationLease()||!this.transaction)throw fault('UI_QT_OBSERVATION_INVALID');
    if(mainBaseline?.epoch!==this.transaction.epoch||mainBaseline?.revision!==this.transaction.revision||mainBaseline?.binding?.pid!==this.transaction.pid||mainBaseline?.binding?.processCreatedFileTimeUtc!==this.transaction.created)throw fault('UI_QT_OBSERVATION_INVALID');
    this.searchReadinessStates??=new WeakMap();let state=this.searchReadinessStates.get(mainBaseline);
    if(!state){state={started:this.now(),waited:0,reads:0,baseline:null,previous:null,stableSince:null};this.searchReadinessStates.set(mainBaseline,state);}
    if(Math.max(this.now()-state.started,state.waited)>600||state.reads>=16)throw fault('UI_QT_SEARCH_RESULTS_UNSTABLE');
    return state;
  }
  searchReadinessFrameMatches(before,after){
    return Boolean(before&&after)&&['clientRect','clientRectInRoot','windowRect'].every(key=>sameRect(before.popup[key],after.popup[key]))&&sameRect(before.regions[0].rect,after.regions[0].rect)&&before.regions[0].rgbaSha256===after.regions[0].rgbaSha256;
  }
  async captureSearchReadinessFrame(mainBaseline,image=false){
    const state=this.searchReadinessState(mainBaseline);state.reads++;let current;
    try{current=await this.capture([],image,{retryPixelChanges:false});}
    catch(error){
      const mismatch=pixelMismatchDiagnostic(error?.pixelMismatch);
      const pixelsChanged=error?.code==='QT_PIXELS_CHANGED'&&mismatch?.stage==='capture'&&mismatch.anchorIndex===0;
      // QtCapture can refuse its final before/after popup-geometry comparison
      // without returning a diagnostic or token. Only an existing complete
      // baseline permits another read here; the absence of a diagnostic proves
      // nothing. Fresh native capture must retain the original lease and every
      // original root/popup identity and fixed-geometry field checked below.
      const captureGeometryChanged=error?.code==='QT_POPUP_BINDING_CHANGED'&&error.popupBindingMismatch===undefined&&state.baseline!==null;
      if(error?.attempted!==false||!pixelsChanged&&!captureGeometryChanged)throw error;
      this.frame=null;state.previous=null;state.stableSince=null;return null;
    }
    try{
      if(Math.max(this.now()-state.started,state.waited)>600)throw fault('UI_QT_SEARCH_RESULTS_UNSTABLE');
      if(current.idleMs<this.config.idleMs)throw fault('UI_USER_ACTIVE');
      if(current.epoch!==mainBaseline.epoch||current.revision!==mainBaseline.revision||!['hwnd','pid','threadId','processCreatedFileTimeUtc','dpi'].every(key=>current.binding[key]===mainBaseline.binding[key])||!sameRect(current.binding.clientRect,mainBaseline.binding.clientRect)||!sameRect(current.binding.captureRect,mainBaseline.binding.captureRect))throw fault('UI_QT_OBSERVATION_CHANGED');
      const p=current.popup,b=state.baseline?.popup;
      if(!inside(current.binding.captureRect,p.windowRect)||p.windowRect.right-p.windowRect.left<p.clientRect.right||p.windowRect.bottom-p.windowRect.top<p.clientRect.bottom)throw fault('UI_QT_OBSERVATION_CHANGED');
      // The native original lease permits search-height changes only. Preserve
      // that same HWND/owner, root identity, top, width and non-client margins;
      // only consecutive *complete* geometry and pixels can become stable.
      if(b&&(!['hwnd','kind','surfaceId','ownerRelation','geometryMode','dpi','stableObservations'].every(key=>p[key]===b[key])
        ||!['clientRect','clientRectInRoot','windowRect'].every(key=>['left','top','right'].every(axis=>p[key][axis]===b[key][axis]))
        ||p.windowRect.bottom-current.binding.captureRect.top-p.clientRectInRoot.bottom!==b.windowRect.bottom-state.baseline.binding.captureRect.top-b.clientRectInRoot.bottom))throw fault('UI_QT_OBSERVATION_CHANGED');
      if(!state.baseline)state.baseline=structuredClone(current);
      return current;
    }catch(error){this.discardNativeFrameImage(current);throw error;}
  }
  async waitForStableSearchResults(mainBaseline,{expectedSource}={}){
    const state=this.searchReadinessState(mainBaseline);
    for(;;){
      if(state.reads){if(Math.max(this.now()-state.started,state.waited)+35>600)break;await this.wait(35);state.waited+=35;}
      const current=await this.captureSearchReadinessFrame(mainBaseline);if(!current)continue;
      const elapsed=Math.max(this.now()-state.started,state.waited),same=this.searchReadinessFrameMatches(state.previous,current);
      // Two equal frames may be a short-lived result plateau. Require the same
      // whole popup geometry and pixels to remain quiet for 125 ms inside the
      // single 600 ms post-paste budget; the final native guard checks again.
      if(!same||state.stableSince===null)state.stableSince=elapsed;
      state.previous=current;
      if(same&&elapsed-state.stableSince>=125&&(!expectedSource||this.searchReadinessFrameMatches(expectedSource,current)))return current;
    }
    throw fault('UI_QT_SEARCH_RESULTS_UNSTABLE');
  }
  async captureSearchSourceAndClose(mainBaseline){
    const state=this.searchReadinessState(mainBaseline);
    for(;;){
      const frame=await this.captureSearchReadinessFrame(mainBaseline,true);let retained=false;
      try{
        const elapsed=Math.max(this.now()-state.started,state.waited),same=this.searchReadinessFrameMatches(state.previous,frame);
        if(!frame||!same||state.stableSince===null||elapsed-state.stableSince<125){
          if(!same||state.stableSince===null)state.stableSince=frame?elapsed:null;
          state.previous=frame;this.frame=null;this.discardNativeFrameImage(frame);await this.waitForStableSearchResults(mainBaseline);continue;
        }
        if(Math.max(this.now()-state.started,state.waited)>600)throw fault('UI_QT_SEARCH_RESULTS_UNSTABLE');
        try{await this.sendObservedPopupEscape(mainBaseline,'search',frame);}
        catch(error){
          const diagnostic=popupBindingMismatchDiagnostic(error?.popupBindingMismatch);
          // This refusal can only request fresh read-only observations. The
          // diagnostic may be incomplete and never supplies a token or a new
          // binding. No input was attempted; a fresh native guard is required.
          if(error?.code!=='QT_POPUP_BINDING_CHANGED'||error.attempted!==false||diagnostic?.stage!=='frame'||diagnostic.inputAttempted!==false||diagnostic.kind!=='search'||diagnostic.observed!==true)throw error;
          this.surface='search';this.frame=null;state.previous=null;state.stableSince=null;this.discardNativeFrameImage(frame);
          await this.waitForStableSearchResults(mainBaseline);continue;
        }
        // Separate the successful Escape from later main-window observations:
        // a failure after input must never enter the no-input recovery above.
        await this.observeMainAfterPopupEscape(mainBaseline,'search');retained=true;return frame;
      }finally{if(frame&&!retained)this.discardNativeFrameImage(frame);}
    }
  }
  async observedContactPanel(captured){
    if(!observedLayout(this.config)||this.surface!=='main')throw fault('UI_QT_CONTACT_PANEL_UNVERIFIED');
    const frame=captured??await this.capture(['header'],true);let file;
    try{
      const directory=path.join(this.root,'state/ui-host/qt-frames');
      if(!object(frame.image)||!hash(frame.image.sha256)||typeof frame.image.file!=='string')throw fault('UI_QT_IMAGE_INVALID');
      file=noLinks(frame.image.file);if(path.dirname(file)!==directory||!/^qt-[a-f0-9]{32}\.png$/.test(path.basename(file))||crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==frame.image.sha256)throw fault('UI_QT_IMAGE_INVALID');
      const layout=this.config.layout,proof=await this.locateContactPanel({root:this.root,file,imageSha256:frame.image.sha256,width:layout.width,height:layout.height,dpi:layout.dpi,executableVersion:this.config.executableVersion,signal:this.operationSignal});this.active();
      const client={left:0,top:0,right:layout.width,bottom:layout.height};
      if(!object(proof)||Object.keys(proof).some(key=>!['version','imageSha256','width','height','dpi','memberRect','panelRect','panelRgbaSha256','memberRgbaSha256','closeRect','closeRgbaSha256','closeRole'].includes(key))||proof.version!==1||proof.imageSha256!==frame.image.sha256||proof.width!==layout.width||proof.height!==layout.height||proof.dpi!==layout.dpi||!rect(proof.panelRect)||!inside(client,proof.panelRect)||!rect(proof.memberRect)||!inside(proof.panelRect,proof.memberRect)||proof.closeRole!=='header-title-toggle'||!rect(proof.closeRect)||!inside(layout.header,proof.closeRect)||!['panelRgbaSha256','memberRgbaSha256','closeRgbaSha256'].every(key=>hash(proof[key])))throw fault('UI_QT_CONTACT_PANEL_UNVERIFIED');
      return proof;
    }finally{if(file&&path.dirname(file)===path.join(this.root,'state/ui-host/qt-frames')&&fs.existsSync(file))fs.unlinkSync(file);}
  }
  async observeCurrentMainTitle(){
    this.active();if(!observedLayout(this.config)||this.surface!=='main'||!this.transaction)throw fault('UI_QT_OBSERVATION_INVALID');
    const frame=await this.capture(['header'],true),layout=this.config.layout;let file;
    try{
      if(!object(frame.image)||!hash(frame.image.sha256)||typeof frame.image.file!=='string')throw fault('UI_QT_IMAGE_INVALID');
      file=noLinks(frame.image.file);const directory=path.join(this.root,'state/ui-host/qt-frames');
      if(path.dirname(file)!==directory||!/^qt-[a-f0-9]{32}\.png$/.test(path.basename(file))||crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==frame.image.sha256)throw fault('UI_QT_IMAGE_INVALID');
      const verify=async()=>{
        const proof=await this.locateMainTitle({root:this.root,file,imageSha256:frame.image.sha256,width:layout.width,height:layout.height,dpi:layout.dpi,executableVersion:this.config.executableVersion,signal:this.operationSignal});this.active();
        if(!object(proof)||Object.keys(proof).length!==13||proof.version!==1||proof.readOnly!==true||proof.inputSent!==false||proof.identityVerified!==false||proof.emptyDraftAuthorized!==false||proof.imageSha256!==frame.image.sha256||proof.width!==layout.width||proof.height!==layout.height||proof.dpi!==layout.dpi||!sameRect(proof.headerRect,layout.header)||!rect(proof.titleRect)||!inside(proof.headerRect,proof.titleRect)||!hash(proof.titleRgbaSha256)||proof.headerRgbaSha256!==frame.regions[0]?.rgbaSha256)throw fault('UI_QT_MAIN_TITLE_UNVERIFIED');
        return proof;
      };
      const proof=await this.withPreparationFocusParked(verify,{includesContactNavigation:true});
      await this.captureCurrentMainTitle(proof);return proof;
    }finally{if(file&&path.dirname(file)===path.join(this.root,'state/ui-host/qt-frames')&&fs.existsSync(file))fs.unlinkSync(file);}
  }
  async captureCurrentMainTitle(proof){
    const frame=await this.capture([proof.headerRect,proof.titleRect]);
    if(frame.regions.length!==2||!sameRect(frame.regions[0].rect,proof.headerRect)||!sameRect(frame.regions[1].rect,proof.titleRect)||frame.regions[0].rgbaSha256!==proof.headerRgbaSha256||frame.regions[1].rgbaSha256!==proof.titleRgbaSha256)throw fault('UI_QT_MAIN_TITLE_CHANGED');
    return frame;
  }
  assertPanelCloseBaseline(baseline){
    const lease=this.preparationLease(),layout=this.config.layout;
    if(!observedLayout(this.config)||this.surface!=='main'||!lease||lease.parked||!this.transaction||baseline?.regions?.length!==2||!sameRect(baseline.regions[0].rect,layout.header)||!sameRect(baseline.regions[1].rect,layout.editor)||!object(baseline.image)||!hash(baseline.image.sha256)||typeof baseline.image.file!=='string')throw fault('UI_QT_OBSERVATION_INVALID');
    this.assertTransaction(baseline);
    const file=baseline.image.file;if(path.dirname(file)!==path.join(this.root,'state/ui-host/qt-frames')||!/^qt-[a-f0-9]{32}\.png$/.test(path.basename(file)))throw fault('UI_QT_IMAGE_INVALID');
    noLinks(file);if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==baseline.image.sha256)throw fault('UI_QT_IMAGE_INVALID');
  }
  panelCloseBindingMatches(baseline,frame){
    return frame.epoch===baseline.epoch&&frame.revision===baseline.revision&&['hwnd','pid','threadId','processCreatedFileTimeUtc','dpi','focusHwnd'].every(key=>frame.binding[key]===baseline.binding[key])&&['clientRect','captureRect'].every(key=>sameRect(frame.binding[key],baseline.binding[key]));
  }
  async clickCurrentMainTitle(proof,{closedBaseline}={}){
    if(closedBaseline){this.assertPanelCloseBaseline(closedBaseline);if(closedBaseline.regions[0].rgbaSha256!==proof.headerRgbaSha256)throw fault('UI_QT_MAIN_TITLE_CHANGED');}
    const frame=await this.captureCurrentMainTitle(proof);this.active();
    if(closedBaseline&&!this.panelCloseBindingMatches(closedBaseline,frame))throw fault('UI_QT_CONTACT_PANEL_CHANGED');
    const result=await this.client.request('click',{rect:proof.titleRect,token:frame.token,epoch:frame.epoch,revision:frame.revision,idleMs:this.config.idleMs});this.frame=null;
    if(result.revision!==this.transaction.revision)throw fault('UI_QT_HUMAN_ACTIVITY_CHANGED');
    if(result.performed!==true||result.attempted!==true)throw fault('UI_QT_MAIN_TITLE_CHANGED');
    if(closedBaseline)return this.captureStablePanelClosed(closedBaseline);
    await this.wait(this.config.settleMs??400);this.active();
  }
  async clickObservedPanel(proof,kind,{transition=false,closedBaseline}={}){
    if(!['member','close'].includes(kind))throw fault('UI_QT_CONTACT_PANEL_UNVERIFIED');
    if(closedBaseline){if(kind!=='close'||transition)throw fault('UI_QT_CONTACT_PANEL_UNVERIFIED');this.assertPanelCloseBaseline(closedBaseline);}
    const region=proof[kind+'Rect'],current=await this.capture([proof.panelRect,region]);
    if(current.regions.length!==2||current.regions[0].rgbaSha256!==proof.panelRgbaSha256||current.regions[1].rgbaSha256!==proof[kind+'RgbaSha256'])throw fault('UI_QT_CONTACT_PANEL_CHANGED');
    if(closedBaseline&&!this.panelCloseBindingMatches(closedBaseline,current))throw fault('UI_QT_CONTACT_PANEL_CHANGED');
    this.active();const result=await this.client.request('click',{rect:region,token:current.token,epoch:current.epoch,revision:current.revision,idleMs:this.config.idleMs,...(transition?this.popupTransition('profile'):{})});this.frame=null;
    if(result.revision!==this.transaction.revision)throw fault('UI_QT_HUMAN_ACTIVITY_CHANGED');
    if(closedBaseline){if(result.performed!==true||result.attempted!==true)throw fault('UI_QT_CONTACT_PANEL_CHANGED');return this.captureStablePanelClosed(closedBaseline);}
    await this.wait(this.config.settleMs??400);this.active();
  }
  discardNativeFrameImage(frame){
    const file=frame?.image?.file;if(typeof file!=='string'||path.dirname(file)!==path.join(this.root,'state/ui-host/qt-frames')||!/^qt-[a-f0-9]{32}\.png$/.test(path.basename(file))||!fs.existsSync(file))return;
    noLinks(file);fs.unlinkSync(file);
  }
  panelFrameHeaderMatches(baseline,frame){
    return frame?.regions?.length===2&&baseline?.regions?.length===2&&frame.epoch===baseline.epoch&&frame.revision===baseline.revision
      &&['hwnd','pid','threadId','processCreatedFileTimeUtc','dpi'].every(key=>frame.binding?.[key]===baseline.binding?.[key])
      &&sameRect(frame.binding?.clientRect,baseline.binding?.clientRect)&&sameRect(frame.binding?.captureRect,baseline.binding?.captureRect)
      &&frame.regions.every((entry,index)=>sameRect(entry.rect,baseline.regions[index].rect))&&frame.regions[0].rgbaSha256===baseline.regions[0].rgbaSha256;
  }
  panelClosedFrameMatches(baseline,frame){
    const proof=this.panelEditorProofs?.get(baseline);
    return this.panelFrameHeaderMatches(baseline,frame)&&Boolean(proof?.observedHashes.has(frame.regions[1].rgbaSha256));
  }
  async captureStablePanelClosed(baseline){
    this.active();if(this.surface!=='main'||!this.transaction)throw fault('UI_QT_OBSERVATION_INVALID');
    const started=this.now();let waited=0,previous,kept;
    const elapsed=()=>Math.max(this.now()-started,waited);
    try{
      for(let attempt=0;attempt<12;attempt++){
        if(attempt){if(elapsed()+35>400)break;await this.wait(35);waited+=35;}this.active();if(elapsed()>400)break;
        let current;
        try{current=await this.capture(['header','editor'],true,{retryPixelChanges:false});}
        catch(error){const mismatch=pixelMismatchDiagnostic(error?.pixelMismatch);if(error?.code!=='QT_PIXELS_CHANGED'||error.attempted!==false||mismatch?.stage!=='capture'||mismatch.anchorIndex!==1)throw error;this.discardNativeFrameImage(previous);previous=null;continue;}
        if(!this.panelFrameHeaderMatches(baseline,current)||current.idleMs<this.config.idleMs){this.discardNativeFrameImage(current);throw fault('UI_QT_CONTACT_PANEL_CLOSE_UNVERIFIED');}
        if(elapsed()>400){this.discardNativeFrameImage(current);break;}
        const stable=previous&&current.regions[1].rgbaSha256===previous.regions[1].rgbaSha256;
        this.discardNativeFrameImage(previous);previous=current;
        if(stable){kept=current;return current;}
      }
      throw fault('UI_QT_CONTACT_PANEL_CLOSE_UNVERIFIED');
    }finally{if(previous!==kept)this.discardNativeFrameImage(previous);}
  }
  async inspectPanelEditorFrame(frame){
    const file=frame?.image?.file,layout=this.config.layout;
    if(typeof file!=='string'||path.dirname(file)!==path.join(this.root,'state/ui-host/qt-frames')||!/^qt-[a-f0-9]{32}\.png$/.test(path.basename(file))||!hash(frame.image.sha256))throw fault('UI_QT_IMAGE_INVALID');
    noLinks(file);if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==frame.image.sha256)throw fault('UI_QT_IMAGE_INVALID');
    const result=await this.inspectPanelEditor({root:this.root,file,imageSha256:frame.image.sha256,width:layout.width,height:layout.height,dpi:layout.dpi,header:layout.header,editor:layout.editor,signal:this.operationSignal});this.active();
    if(!object(result)||Object.keys(result).length!==13||result.version!==1||result.readOnly!==true||result.inputSent!==false||result.emptyDraftAuthorized!==false||result.identityVerified!==false||result.imageSha256!==frame.image.sha256||result.width!==layout.width||result.height!==layout.height||result.dpi!==layout.dpi||result.headerRgbaSha256!==frame.regions[0].rgbaSha256||result.editorRgbaSha256!==frame.regions[1].rgbaSha256||!hash(result.canonicalEditorSha256)||typeof result.caretCandidate!=='boolean'||!result.caretCandidate&&result.editorRgbaSha256!==result.canonicalEditorSha256)throw fault('UI_QT_CONTACT_PANEL_CLOSE_UNVERIFIED');
    return result;
  }
  async verifyObservedPanelClosed(baseline,{captured,park=true}={}){
    const frame=captured??await this.captureStablePanelClosed(baseline);let file;
    try{
      const directory=path.join(this.root,'state/ui-host/qt-frames');
      if(!object(frame.image)||!hash(frame.image.sha256)||typeof frame.image.file!=='string')throw fault('UI_QT_IMAGE_INVALID');
      file=noLinks(frame.image.file);if(path.dirname(file)!==directory||!/^qt-[a-f0-9]{32}\.png$/.test(path.basename(file))||crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==frame.image.sha256)throw fault('UI_QT_IMAGE_INVALID');
      if(!this.panelFrameHeaderMatches(baseline,frame))throw fault('UI_QT_CONTACT_PANEL_CLOSE_UNVERIFIED');
      const layout=this.config.layout;
      const verify=async()=>{
        const prior=this.panelEditorProofs?.get(baseline);
        const [proof,original,current]=await Promise.all([
          this.verifyPanelClosed({root:this.root,file,imageSha256:frame.image.sha256,width:layout.width,height:layout.height,dpi:layout.dpi,executableVersion:this.config.executableVersion,signal:this.operationSignal}),
          prior?Promise.resolve(prior.original):this.inspectPanelEditorFrame(baseline),this.inspectPanelEditorFrame(frame),
        ]);this.active();
        if(!object(proof)||Object.keys(proof).length!==8||proof.version!==1||proof.closed!==true||proof.readOnly!==true||proof.inputSent!==false||proof.imageSha256!==frame.image.sha256||proof.width!==layout.width||proof.height!==layout.height||proof.dpi!==layout.dpi)throw fault('UI_QT_CONTACT_PANEL_CLOSE_UNVERIFIED');
        if(original.canonicalEditorSha256!==current.canonicalEditorSha256)throw fault('UI_QT_CONTACT_PANEL_CLOSE_UNVERIFIED');
        const observedHashes=new Set([...(prior?.observedHashes??[]),original.editorRgbaSha256,current.editorRgbaSha256]);
        // Only actual images of this transaction enter the phase set. This is
        // not a draft permission; readDraft must still prove clipboard/rich content.
        if(observedHashes.size>2)throw fault('UI_QT_CONTACT_PANEL_CLOSE_UNVERIFIED');
        this.panelEditorProofs??=new WeakMap();this.panelEditorProofs.set(baseline,{original,observedHashes});
      };
      if(park)await this.withPreparationFocusParked(verify,{includesContactNavigation:true});else await verify();
      if(park&&!this.panelClosedFrameMatches(baseline,await this.capture(['header','editor'])))throw fault('UI_QT_CONTACT_PANEL_CLOSE_UNVERIFIED');
    }finally{if(file&&path.dirname(file)===path.join(this.root,'state/ui-host/qt-frames')&&fs.existsSync(file))fs.unlinkSync(file);}
  }
  async selectPrivateSearchResult(expected, target, {close,reopen,captureAndClose}={}) {
    const adaptive=observedLayout(this.config);
    if(!adaptive&&!rect(this.config.layout.searchResultIdentity))throw fault('UI_QT_SEARCH_IDENTITY_CALIBRATION_REQUIRED');
    const sourceClosed=adaptive&&this.preparationLease()&&typeof captureAndClose==='function';
    const frame=sourceClosed?await captureAndClose():await this.capture(adaptive?[]:['searchResultIdentity'],true),popupArea=adaptive?frame.regions[0].rect:this.config.layout.searchResultIdentity;let imageFile,area=popupArea,click=this.config.layout.firstResult;
    try{
      if(!object(frame.image)||!hash(frame.image.sha256)||typeof frame.image.file!=='string')throw fault('UI_QT_IMAGE_INVALID');
      imageFile=noLinks(frame.image.file);const directory=path.join(this.root,'state/ui-host/qt-frames');
      if(path.dirname(imageFile)!==directory||!/^qt-[a-f0-9]{32}\.png$/.test(path.basename(imageFile))||crypto.createHash('sha256').update(fs.readFileSync(imageFile)).digest('hex')!==frame.image.sha256)throw fault('UI_QT_IMAGE_INVALID');
      const verify=async()=>{
      if(adaptive){
        const proof=await this.locateSearchPopup({root:this.root,image:imageFile,imageSha256:frame.image.sha256,width:frame.binding.clientRect.right,height:frame.binding.clientRect.bottom,dpi:frame.binding.dpi,popup:popupArea,signal:this.operationSignal});this.active();
        if(!object(proof)||Object.keys(proof).length!==12||proof.version!==1||proof.ok!==true||proof.readOnly!==true||proof.inputSent!==false||proof.identityVerified!==false||proof.imageSha256!==frame.image.sha256||proof.width!==frame.binding.clientRect.right||proof.height!==frame.binding.clientRect.bottom||proof.dpi!==frame.binding.dpi||!sameRect(proof.popupRect,popupArea)||proof.popupRgbaSha256!==frame.regions[0]?.rgbaSha256||!rect(proof.contentRect)||!inside(popupArea,proof.contentRect))throw fault('UI_QT_SEARCH_POPUP_CONTENT_UNVERIFIED');
        area=proof.contentRect;
      }
      const regionOcr=adaptive&&this.config.ocrBackend==='rapidocr';
      const ocr=await this.recognize({file:imageFile,backend:this.config.ocrBackend,model:'small',...(regionOcr?{region:area}:{}),signal:this.operationSignal});
      if(ocr.imageSha256!==frame.image.sha256||adaptive&&(ocr.width!==frame.binding.clientRect.right||ocr.height!==frame.binding.clientRect.bottom)||regionOcr&&(ocr.model!=='PP-OCRv6-small'||ocr.preprocess!==undefined||!sameRect(ocr.region,area)))throw fault('UI_QT_PRIVATE_CHAT_UNVERIFIED');
      const observed=adaptive?observedPrivateSearchResult(ocr,area,expected):null;
      if(!(adaptive?observed:exactPrivateSearchResult(ocr,area,click,expected))){
        // The first full image must already read the same exact labeled ID in
        // the same valid private row. Only uncertain confidence may request a
        // second model on the complete calibrated row (category, name and ID).
        // It uses the original pixels, never the search box or expected text;
        // the final result retains all original identity/confidence thresholds.
        if(this.config.ocrBackend!=='rapidocr'||!(adaptive?observedPrivateSearchResult(ocr,area,expected,false):privateSearchResult(ocr,area,click,expected,false))||!Number.isInteger(ocr.width)||!Number.isInteger(ocr.height)||ocr.width<1||ocr.height<1)throw fault('UI_QT_PRIVATE_CHAT_UNVERIFIED');
        this.active();const retry=await this.recognize({file:imageFile,backend:'rapidocr',model:'medium',region:area,signal:this.operationSignal});
        const retried=adaptive?observedPrivateSearchResult(retry,area,expected):null;
        if(retry.imageSha256!==frame.image.sha256||retry.model!=='PP-OCRv6-medium'||retry.preprocess!==undefined||!object(retry.region)||['left','top','right','bottom'].some(key=>retry.region[key]!==area[key])||retry.width!==ocr.width||retry.height!==ocr.height||!(adaptive?retried:exactPrivateSearchResult(retry,area,click,expected)))throw fault('UI_QT_PRIVATE_CHAT_UNVERIFIED');
        if(adaptive)click=retried.click;
      }else if(adaptive)click=observed.click;
      };
      if(this.preparationLease()&&typeof close==='function'&&typeof reopen==='function'){
        if(!sourceClosed)await close();await this.withPreparationFocusParked(verify,{includesContactNavigation:true});await reopen(frame);
      }else await verify();
      const current=await this.capture(adaptive?[]:['searchResultIdentity']);
      if(current.regions.length!==1||frame.regions.length!==1||!sameRect(current.regions[0].rect,frame.regions[0].rect)||current.regions[0].rgbaSha256!==frame.regions[0].rgbaSha256)throw fault('UI_QT_SEARCH_RESULT_CHANGED');
      // Submit the exact confirmed token: another capture here would discard
      // the OCR-to-click anchor and permit a changed result to be selected.
      this.active();const result=await this.client.request('click',{rect:click,token:current.token,epoch:current.epoch,revision:current.revision,idleMs:this.config.idleMs});this.frame=null;
      if(result.revision!==this.transaction.revision)throw fault('UI_QT_HUMAN_ACTIVITY_CHANGED');
      await this.wait(this.config.settleMs??400);this.active();
      return{kind:'exact-private-search-row-v1',account:this.config.account,target};
    }finally{if(imageFile&&path.dirname(imageFile)===path.join(this.root,'state/ui-host/qt-frames')&&fs.existsSync(imageFile))fs.unlinkSync(imageFile);}
  }
  async freshAccount({frame,park=true}={}) {
    frame??=await this.capture(['header']);
    const inspect=()=>this.probeAccount({ root:this.root,binding:frame.binding,executable:this.config.executable,expectedAccountRef:this.config.accountRef,signal:this.operationSignal });
    const result = park&&this.preparationLease()&&this.surface==='main'?await this.withPreparationFocusParked(inspect):await inspect();
    if (result?.accountRef !== this.config.accountRef || result.evidence?.processOpenedExpectedDatabase !== true || result.evidence?.processId !== frame.binding.pid || result.evidence?.processCreatedFileTimeUtc !== frame.binding.processCreatedFileTimeUtc) throw fault('UI_QT_ACCOUNT_UNVERIFIED');
    return result;
  }
  async warmUiaLocators({owner=this.client,inspection,signal=this.operationSignal}={}){
    if(this.config.layoutMode!=='uia-v1'||this.navigationPolicy!=='uia-controls-v1')return;
    const active=()=>{this.active();if(signal?.aborted)throw fault('UI_QT_CANCELLED');if(owner!==this.client)throw fault('UI_QT_CONTROLS_BINDING_CHANGED');};active();
    const config=structuredClone(this.config),layout=config.layout;inspection??=await owner.request('inspectLayout');active();const binding=inspection?.binding;
    if(inspection?.readOnly!==true||inspection.inputSent!==false||inspection.focusChanged!==false||inspection.clipboardAccessed!==false||inspection.executableVersion!==config.executableVersion||inspection.executableSha256!==config.executableSha256||
      !object(binding)||!positiveDecimal(binding.hwnd)||!positiveDecimal(binding.processCreatedFileTimeUtc)||!Number.isSafeInteger(binding.pid)||binding.pid<=0||binding.pid>0xffffffff||typeof binding.foreground!=='boolean'||config.hwnd!=='auto'&&binding.hwnd!==config.hwnd||binding.dpi!==layout.dpi||
      !sameRect(binding.clientRect,{left:0,top:0,right:layout.width,bottom:layout.height})||!object(binding.captureRect)||!['left','top','right','bottom'].every(key=>Number.isSafeInteger(binding.captureRect[key]))||binding.captureRect.right-binding.captureRect.left!==layout.width||binding.captureRect.bottom-binding.captureRect.top!==layout.height)throw fault('UI_QT_UIA_WARMUP_UNCONFIRMED');
    const keys=['hwnd','pid','processCreatedFileTimeUtc','dpi','clientRect','captureRect'],expectedBinding=Object.fromEntries(keys.map(key=>[key,structuredClone(binding[key])]));
    // This memo only avoids repeating cold-start work on the same host and
    // window. It never supplies an observation or skips live input checks.
    if(this.uiaWarmHint?.owner===owner&&isDeepStrictEqual(this.uiaWarmHint.binding,expectedBinding))return;
    const result=await owner.request('warmUiaLocators',{expectedBinding});active();
    const fields=['version','warmed','readOnly','inputSent','focusChanged','clipboardAccessed','authorizationGranted','foregroundUnchanged','inputTickUnchanged','cursorUnchanged','binding','roles'];
    if(!object(result)||Object.keys(result).length!==fields.length||Object.keys(result).some(key=>!fields.includes(key))||result.version!==1||result.warmed!==true||result.readOnly!==true||result.inputSent!==false||result.focusChanged!==false||result.clipboardAccessed!==false||result.authorizationGranted!==false||
      result.foregroundUnchanged!==true||result.inputTickUnchanged!==true||result.cursorUnchanged!==true||!isDeepStrictEqual(result.roles,['header','editor','send'])||!object(result.binding)||Object.keys(result.binding).length!==7||Object.keys(result.binding).some(key=>!keys.includes(key)&&key!=='foreground')||typeof result.binding.foreground!=='boolean'||result.binding.foreground!==binding.foreground||
      !keys.every(key=>isDeepStrictEqual(result.binding[key],expectedBinding[key]))||!isDeepStrictEqual(config,this.config))throw fault('UI_QT_UIA_WARMUP_UNCONFIRMED');
    this.uiaWarmHint={owner,binding:structuredClone(expectedBinding)};
  }
  async readDraft(job) {
    // Moving away from the editor removes its hover/placeholder variation.
    // This is a fresh guarded move only: the editor keeps keyboard focus and
    // the native empty-template observation retains its original time limit.
    const pointerParkRect=this.config.layout.pointerParkRect??this.config.layout.focusActivateRect;
    if(pointerParkRect){
      const parked=await this.action('movePointer',{rect:pointerParkRect},[pointerParkRect]);
      if(parked.performed!==true||parked.pointerParked!==true||parked.focusPreserved!==true)throw fault('UI_QT_POINTER_PARK_UNCONFIRMED');
    }
    // The read operation verifies the complete copied text/companions (or an
    // exact empty-editor template). Anchoring it to a caret bitmap would reject
    // an otherwise unchanged editor on every blink. Submission still anchors
    // the editor returned by the fresh post-read capture below.
    const frame = await this.capture(['header']);
    let result;const verifiedEmptyHashes=qtEmptyEditorHashes(this.config.layout);
    try { result = await this.client.request('readDraft', { token:frame.token,epoch:frame.epoch,revision:frame.revision,idleMs:this.config.idleMs,editorRect:this.config.layout.editor,...(observedLayout(this.config)&&this.preparationLease()?{headerRect:this.config.layout.header,...(job?{stepBinding:this.textStepBinding(job)}:{})}:{}),emptyEditorSha256:this.config.layout.emptyEditorSha256,emptyEditorSha256s:verifiedEmptyHashes }); }
    catch(error) {
      if(preparationWaits.has(codeFor(error))&&error?.attempted!==false&&error?.clipboardRestored!==true)throw fault('UI_QT_CLEANUP_UNCONFIRMED');
      throw error;
    }
    this.frame = null;
    if (result.draftVerified !== true || result.clipboardRestored !== true || typeof result.draft !== 'string' || result.draft.length > 16000 || result.revision !== this.transaction.revision || result.draft === '' && result.emptyTemplateMatched !== true) throw fault('UI_QT_DRAFT_UNVERIFIED');
    const emptyDraftPhaseProof=result.draft===''?validateQtEmptyDraftPhaseProof(result.emptyDraftPhaseProof,this.config.layout.editor,verifiedEmptyHashes):undefined;
    if(emptyDraftPhaseProof&&result.richContentVerified!==true)throw fault('UI_QT_EMPTY_PHASE_PROOF_INVALID');
    const shared=observedLayout(this.config)&&Boolean(this.preparationLease()),current=shared&&result.draft!==''?this.acceptPostPasteFrame(result.postPasteFrame,frame,['header','editor']):await this.capture(['header','editor']);
    const verifiedEmptyPhase=emptyDraftPhaseProof&&!verifiedEmptyHashes.includes(current.regions[1].rgbaSha256)?await this.inspectEmptyDraftPhase(current,emptyDraftPhaseProof):undefined;
    const draft=result.draft.replace(/\r\n/g,'\n').replace(/\r/g,'\n');
    return { draft,frame:current,...(shared&&draft!==''?{textEnterProof:this.nativeTextProof(result.textEnterProof,draft)}:{}),...(draft===''?{verifiedEmptyHashes:Object.freeze([...verifiedEmptyHashes]),emptyDraftPhaseProof,verifiedEmptyPhase}:{}) };
  }
  async inspectEmptyDraftPhase(frame,proof){
    this.active();this.assertTransaction(frame);
    const value=await this.client.request('inspectEmptyEditorPhase',{token:frame.token,epoch:frame.epoch,revision:frame.revision,idleMs:this.config.idleMs,emptyDraftPhaseProofId:proof.id});
    this.active();return validateQtEmptyDraftPhase(value,proof,frame);
  }
  async closePreparationPopupAfterFailure(){
    const surface=this.surface,lease=this.preparationLease(),calibration=this.popupCalibration(surface);
    if(this.closed||this.operationSignal?.aborted||!this.transaction||!['self','profile'].includes(surface)||this.config[surface+'CloseKey']!=='Escape'||!calibration||lease?.parked)return{attempted:false,closed:false};
    const configured=this.config[surface+'Surface'],names=observedLayout(this.config)?[]:[{left:0,top:0,right:configured.width,bottom:configured.height}];
    // Only the popup causally opened by this transaction can be dismissed.
    // Capture/guard failures never produce an Escape aimed at another window.
    const frame=await this.capture(names,false,{retryPixelChanges:false});this.active();
    const result=await this.client.request('chord',{key:'Escape',token:frame.token,epoch:frame.epoch,revision:frame.revision,idleMs:this.config.idleMs});this.frame=null;
    if(result.revision!==this.transaction.revision)throw fault('UI_QT_HUMAN_ACTIVITY_CHANGED');
    this.surface='main';await this.wait(this.config.settleMs??400);this.active();
    await this.capture(['header'],false,{retryPixelChanges:false});
    return{attempted:true,closed:true};
  }
  acceptPostPasteFrame(value,before,names,{conversationFingerprint}={}){
    this.assertTransaction(value);
    const dynamicSearch=this.surface==='search'&&before.observationKind==='uia-metadata-v1'&&value.observationKind==='uia-metadata-v1'&&names.length===1&&names[0]==='search';
    if(value.idleMs<this.config.idleMs||!['hwnd','pid','threadId','processCreatedFileTimeUtc','dpi'].every(key=>value.binding[key]===before.binding[key])||!['clientRect','captureRect'].every(key=>sameRect(value.binding[key],before.binding[key]))||value.regions.length!==names.length||!value.regions.every((entry,index)=>dynamicSearch?entry.role==='search'&&inside(value.binding.clientRect,entry.rect):sameRect(entry.rect,this.region(names[index]))))throw fault('UI_QT_PASTE_UNVERIFIED');
    if(this.surface==='search'){
      const a=before.popup,b=value.popup;
      if(!a||!b||!['hwnd','surfaceId','kind','ownerRelation','geometryMode','dpi','stableObservations'].every(key=>a[key]===b[key]))throw fault('UI_QT_PASTE_UNVERIFIED');
      if(a.offscreenSearch!==undefined||b.offscreenSearch!==undefined){
        if(!dynamicSearch||!this.uiaOffscreenSearchFrame(before)||!this.uiaOffscreenSearchFrame(value)||a.clientRect.right!==b.clientRect.right||a.windowRect.right-a.windowRect.left!==b.windowRect.right-b.windowRect.left||!isDeepStrictEqual(this.uiaOffscreenPopupMargins(before),this.uiaOffscreenPopupMargins(value)))throw fault('UI_QT_PASTE_UNVERIFIED');
      }else if(!['clientRect','clientRectInRoot','windowRect'].every(key=>object(b[key])&&['left','top','right'].every(axis=>a[key][axis]===b[key][axis]))||!rect(b.clientRect)||!rect(b.clientRectInRoot)||!inside(value.binding.clientRect,b.clientRectInRoot)||!inside(value.binding.captureRect,b.windowRect)||b.clientRectInRoot.bottom-b.clientRectInRoot.top!==b.clientRect.bottom||b.windowRect.bottom-value.binding.captureRect.top-b.clientRectInRoot.bottom!==a.windowRect.bottom-before.binding.captureRect.top-a.clientRectInRoot.bottom)throw fault('UI_QT_PASTE_UNVERIFIED');
    }else if(value.popup||this.regionDigest(value)!==this.regionDigest(before)&&!(before.uiaControlFrame===true&&value.uiaControlFrame===true&&this.navigationPolicy==='uia-controls-v1'&&validConversationFingerprint(conversationFingerprint)))throw fault('UI_QT_PASTE_UNVERIFIED');
    if(before.observationKind==='uia-metadata-v1'&&(value.observationKind!=='uia-metadata-v1'||value.regions.some((entry,index)=>entry.role!==names[index])||this.surface!=='search'&&(before.uiaControlFrame!==true||value.uiaControlFrame!==true)))throw fault('UI_QT_PASTE_UNVERIFIED');
    if(dynamicSearch)this.uiaSearchRegion={popupHwnd:value.popup.hwnd,rect:structuredClone(value.regions[0].rect)};
    this.frame=value;return value;
  }
  nativeTextProof(value,text){
    if(!object(value)||Object.keys(value).length!==3||value.version!==1||!/^[a-f0-9]{32}$/.test(value.id??'')||value.textSha256!==crypto.createHash('sha256').update(text).digest('hex'))throw fault('UI_QT_TEXT_ENTER_PROOF_INVALID');
    return structuredClone(value);
  }
  appliedPaste(result,text){
    if(result?.performed!==true||result.attempted!==true||result.pasteApplied!==true||result.readbackPerformed!==false||result.intendedText!==text||!clipboardSettled(result,this.allowClipboardReplacement)||typeof result.interrupted!=='boolean'||result.revision!==this.transaction.revision)throw fault('UI_QT_PASTE_UNCONFIRMED');
    if(this.config.layoutMode==='uia-v1'&&result.uiaConsumptionConfirmed!==true)throw fault('UI_QT_PASTE_UNCONFIRMED');return result;
  }
  appliedTypedText(result,text){
    if(result?.performed!==true||result.attempted!==true||result.typeApplied!==true||result.readbackPerformed!==false||result.intendedText!==text||result.clipboardAccessed!==false||typeof result.interrupted!=='boolean'||result.revision!==this.transaction.revision)throw fault('UI_QT_TYPED_TEXT_UNCONFIRMED');
    return result;
  }
  async sharedAction(action,values={},names=['header'],frame){
    frame??=await this.capture(names);this.active();this.assertTransaction(frame);
    const result=await this.client.request(action,{...values,token:frame.token,epoch:frame.epoch,revision:frame.revision,idleMs:this.config.idleMs});this.frame=null;
    if(result.revision!==this.transaction.revision)throw fault('UI_QT_HUMAN_ACTIVITY_CHANGED');
    const editor=this.config.layoutMode==='uia-v1'&&this.navigationPolicy==='uia-controls-v1'&&action==='focusUiaEditor';
    if(result.performed!==true||result.attempted!==true&&!(editor&&uiaEditorFocusReused(result))||editor&&result.pointerDelivery!=null&&!validUiaPointerDelivery(result.pointerDelivery,'editor-focus'))throw fault('UI_QT_INPUT_UNVERIFIED');return result;
  }
  textStepBinding(job){
    this.checkJob(job);if(!hash(job.id))throw fault('UI_QT_TEXT_STEP_BINDING_INVALID');
    const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
    return {version:1,deliveryId:job.id,accountSha256:digest(job.account),targetSha256:digest(job.target)};
  }
  resumableTextStep(previous,job){
    if(!previous?.shared||previous.jobId!==job.id||previous.account!==job.account||previous.target!==job.target||!previous.textEnterProof||!previous.draft||previous.textStage!=='pasted')return false;
    this.nativeTextProof(previous.textEnterProof,previous.draft);
    if(JSON.stringify(previous.stepBinding)!==JSON.stringify(this.textStepBinding(job)))throw fault('UI_QT_TEXT_STEP_BINDING_INVALID');
    return true;
  }
  async resumeTextStep(previous,job,frame){
    if(!this.resumableTextStep(previous,job)||!sharedTargetProof(previous.privateChatProof)||previous.privateChatProof.account!==job.account||previous.privateChatProof.target!==job.target||frame.popup||frame.regions.length!==2||!previous.binding||!['hwnd','pid','threadId','processCreatedFileTimeUtc','dpi'].every(key=>frame.binding[key]===previous.binding[key])||!['clientRect','captureRect'].every(key=>sameRect(frame.binding[key],previous.binding[key]))||this.regionDigest(frame,0)!==previous.header)throw fault('UI_QT_PARTIAL_DRAFT_RECHECK_REQUIRED');
    // Resume the completed paste, not the entire delivery. Native refocuses the
    // original editor and rebinds its saved input proof to this transaction;
    // it does not copy, search, paste or send a second time.
    const result=await this.client.request('resumeTextEnterProof',{token:frame.token,epoch:frame.epoch,revision:frame.revision,idleMs:this.config.idleMs,textEnterProofId:previous.textEnterProof.id,textSha256:previous.textEnterProof.textSha256,stepBinding:this.textStepBinding(job),headerRect:this.config.layout.header,editorRect:this.config.layout.editor});
    if(result.performed!==true||result.attempted!==true||result.resumed!==true||result.revision!==frame.revision)throw fault('UI_QT_TEXT_RESUME_UNVERIFIED');
    const resumed=this.acceptPostPasteFrame(result.postPasteFrame,frame,['header','editor']),proof=this.nativeTextProof(result.textEnterProof,previous.draft);
    this.current={...previous,epoch:resumed.epoch,revision:resumed.revision,binding:structuredClone(resumed.binding),header:this.regionDigest(resumed,0),editor:this.regionDigest(resumed,1),editorToken:crypto.randomUUID(),verifiedAt:this.now(),textEnterProof:proof};
    this.sharedDraftResume=null;this.draftHold=null;return {ready:true};
  }
  acceptUiaEditorFocus(result,baseline){
    const frame=result?.postFocusFrame;this.assertTransaction(frame);
    if(result.performed!==true||result.attempted!==true&&!uiaEditorFocusReused(result)||result.pointerDelivery!=null&&!validUiaPointerDelivery(result.pointerDelivery,'editor-focus')||result.editorFocused!==true||frame.observationKind!=='uia-metadata-v1'||frame.pixelsRead!==false||frame.regions?.[0]?.role!=='header'||frame.regions?.[1]?.role!=='editor'||frame.uiaControlFrame!==true||frame.navigationOnly===true||frame.popup||frame.regions.length!==2||
      !sameRect(frame.regions[0].rect,this.config.layout.header)||!sameRect(frame.regions[1].rect,this.config.layout.editor)||
      !['hwnd','pid','threadId','processCreatedFileTimeUtc','dpi'].every(key=>frame.binding[key]===baseline.binding[key])||!['clientRect','captureRect'].every(key=>sameRect(frame.binding[key],baseline.binding[key])))throw fault('UI_QT_CONTROLS_BINDING_CHANGED');
    this.frame=frame;return frame;
  }
  async uiaConversationReady(job,baseline,lookup,searchPopupHwnd='0',{allowLayoutRefresh=false}={}){
    if(this.config.layoutMode!=='uia-v1'||!uiaTargetEvidence(lookup)||lookup.account!==job.account||lookup.target!==job.target||lookup.accountRef!==this.config.accountRef||lookup.uiaTarget.proof==='database-exact-alias-v1'&&searchPopupHwnd==='0')throw fault('UI_QT_TARGET_CHANGED');
    const request={version:1,expectedTitleSha256:lookup.uiaTarget.titleSha256,expectedQuerySha256:lookup.uiaTarget.querySha256,searchPopupHwnd};
    const proof=await this.verifyControlBinding(job,baseline,'navigation-ready',this.operationSignal,{navigationReadiness:request,allowLayoutRefresh}),ready=proof?.navigationReady;
    if(!object(ready)||ready.version!==1||typeof ready.ready!=='boolean'||ready.querySha256!==request.expectedQuerySha256||ready.searchPopupHwnd!==searchPopupHwnd)throw fault('UI_QT_CONTROLS_UNVERIFIED');
    if(ready.ready&&(ready.primaryTitleSha256!==request.expectedTitleSha256||ready.samePage!==true||ready.editorWritable!==true||ready.searchClosed!==true||!validConversationFingerprint(proof.conversationFingerprint)))throw fault('UI_QT_CONTROLS_UNVERIFIED');
    return {ready:ready.ready,proof};
  }
  adoptUiaNavigationLayout(candidate,baseline,job,lease){
    this.active();this.assertTransaction(baseline);
    if(this.config.layoutMode!=='uia-v1'||this.navigationPolicy!=='uia-controls-v1'||this.controlVerificationPolicy!=='input-boundaries-v1'||!object(this.config.voice?.recordingUi?.uia??this.config.voice?.recordingUi?.adaptive)||this.current||job.index>0||job.pendingInput||this.draftHold||this.sharedDraftResume?.draft||!lease||lease!==this.preparationLease()||lease.parked||lease.owner!==this.client||this.surface!=='main'||
      !object(candidate)||Object.keys(candidate).length!==4||candidate.version!==1||!object(candidate.binding)||Object.keys(candidate.binding).length!==7||
      !['hwnd','pid','threadId','processCreatedFileTimeUtc','dpi'].every(key=>candidate.binding[key]===baseline.binding[key])||!['clientRect','captureRect'].every(key=>sameRect(candidate.binding[key],baseline.binding[key]))||
      !object(candidate.layout)||Object.keys(candidate.layout).length!==7||!['width','height','dpi'].every(key=>candidate.layout[key]===this.config.layout[key])||!['search','header','editor','send'].every(key=>rect(candidate.layout[key])&&inside(baseline.binding.clientRect,candidate.layout[key]))||
      !object(candidate.voice)||Object.keys(candidate.voice).length!==2||!['recordStartRect','toolbarRect'].every(key=>rect(candidate.voice[key])&&inside(baseline.binding.clientRect,candidate.voice[key])))throw fault('UI_QT_CONTROLS_BINDING_CHANGED');
    const next=structuredClone(this.config);next.layout=structuredClone(candidate.layout);next.voice.recordStartRect=structuredClone(candidate.voice.recordStartRect);
    if(next.voice.recordingUi.uia)next.voice.toolbarRect=structuredClone(candidate.voice.toolbarRect);else next.voice.recordingUi.adaptive.toolbarRect=structuredClone(candidate.voice.toolbarRect);
    // The native helper keeps its exact lease/search-generation authority. Only
    // observed role regions change; no helper restart or new input grant occurs.
    this.config=validateQtConfig(next);
  }
  async waitForUiaSearchTransition(job,baseline,lookup,searchPopupHwnd,searchGeneration){
    if(!positiveDecimal(searchPopupHwnd)||!/^[a-f0-9]{32}$/.test(searchGeneration??''))throw fault('UI_QT_SEARCH_ENTER_PROOF_INVALID');
    const started=this.now(),lease=this.preparationLease();let waited=0;
    // Poll live readiness; there is no pixel-settling interval in this path.
    // Keep the full 600 ms budget even when reads finish immediately.
    for(let index=0;index<61;index++){
      this.active();if(Math.max(this.now()-started,waited)>600)break;
      const result=await this.uiaConversationReady(job,baseline,lookup,searchPopupHwnd,{allowLayoutRefresh:true});this.active();
      if(Math.max(this.now()-started,waited)>600)break;
      if(result.ready){
        if(result.proof.navigationLayout)this.adoptUiaNavigationLayout(result.proof.navigationLayout,baseline,job,lease);
        const focused=await this.client.request('focusUiaReadyEditor',{searchGeneration,headerRect:this.config.layout.header,editorRect:this.config.layout.editor,idleMs:this.config.idleMs,uiaReady:{version:1,proof:'uia-controls-v1',binding:baseline.binding}});
        return {frame:this.acceptUiaEditorFocus(focused,baseline),fingerprint:structuredClone(result.proof.conversationFingerprint)};
      }
      if(Math.max(this.now()-started,waited)+10>600)break;
      await this.wait(10);waited+=10;
    }
    throw fault('UI_QT_SEARCH_TRANSITION_UNCONFIRMED',{[navigationTransitionFailure]:true});
  }
  async waitForSearchEnterTransition(baseline){
    const started=this.now(),unchangedGraceMs=350;let waited=0,previous,stableSince,headerChanged=false;
    for(let index=0;index<18;index++){
      if(index){if(Math.max(this.now()-started,waited)+35>600)break;await this.wait(35);waited+=35;}this.active();if(Math.max(this.now()-started,waited)>600)break;
      let current;try{current=await this.capture(['header','editor'],false,{retryPixelChanges:false});}
      catch(error){const mismatch=pixelMismatchDiagnostic(error?.pixelMismatch);if(error?.attempted!==false||!(['QT_WINDOW_OBSCURED','DRAFT_WINDOW_POPUP_ACTIVE','DRAFT_WINDOW_NOT_FOREGROUND'].includes(error.code)||error.code==='QT_PIXELS_CHANGED'&&mismatch?.stage==='capture'&&[0,1].includes(mismatch.anchorIndex)))throw error;previous=null;stableSince=undefined;continue;}
      if(Math.max(this.now()-started,waited)>600)break;
      if(!['hwnd','pid','threadId','processCreatedFileTimeUtc','dpi'].every(key=>current.binding[key]===baseline.binding[key])||!['clientRect','captureRect'].every(key=>sameRect(current.binding[key],baseline.binding[key]))||current.idleMs<this.config.idleMs||current.popup||current.regions.length!==2||!sameRect(current.regions[0].rect,this.config.layout.header)||!sameRect(current.regions[1].rect,this.config.layout.editor))throw fault('UI_QT_SEARCH_TRANSITION_CHANGED');
      // Wait for the search UI transition before editor input.
      // Selecting an already open conversation may legitimately keep its header.
      const binding=current.binding,caret=binding.caretRectInClient,elapsed=Math.max(this.now()-started,waited);
      // Opening a conversation need not focus its editor. An explicit native
      // no-caret snapshot is legal here; the following click focuses the editor.
      const noCaret=binding.caretHwnd==='0'&&binding.caretBelongsToWindow===false&&binding.guiFlags===0&&object(caret)&&Object.keys(caret).length===4&&['left','top','right','bottom'].every(key=>caret[key]===0);
      const editorCaret=binding.caretHwnd===binding.hwnd&&binding.caretBelongsToWindow===true&&binding.guiFlags===1&&rect(caret)&&inside(this.config.layout.editor,caret);
      if(binding.focusHwnd!==binding.hwnd||binding.focusBelongsToWindow!==true||!noCaret&&!editorCaret){previous=null;stableSince=undefined;continue;}
      // Qt can dismiss search while still painting the previous conversation.
      // Old frames never establish the stability of a newly presented header.
      // An unchanged header can also mean the requested chat was already open;
      // allow that case only after a bounded presentation grace and fresh reads.
      // This observes page completion, not the contact's identity.
      if(baseline.baselinePixelStable===false&&elapsed<unchangedGraceMs){previous=null;stableSince=undefined;continue;}
      if(this.regionDigest(current,0)!==this.regionDigest(baseline,0))headerChanged=true;
      else if(headerChanged||elapsed<unchangedGraceMs){previous=null;stableSince=undefined;continue;}
      const same=previous&&current.regions.every((entry,index)=>entry.rgbaSha256===previous.regions[index].rgbaSha256);
      if(!same)stableSince=elapsed;
      if(same&&elapsed-stableSince>=35)return current;
      previous=current;
    }
    throw fault('UI_QT_SEARCH_TRANSITION_UNCONFIRMED',{[navigationTransitionFailure]:true});
  }
  async waitForSharedSearchQuery(){
    const uia=this.config.layoutMode==='uia-v1'&&this.navigationPolicy==='uia-controls-v1',cadence=uia?10:35,maxReads=uia?61:18;
    const started=this.now();let waited=0;
    for(let index=0;index<maxReads;index++){
      if(index){if(Math.max(this.now()-started,waited)+cadence>600)break;await this.wait(cadence);waited+=cadence;}
      this.active();if(Math.max(this.now()-started,waited)>600)break;
      try{
        const frame=await this.capture(['search'],false,{retryPixelChanges:false});
        if(Math.max(this.now()-started,waited)<=600)return frame;
        break;
      }catch(error){
        const mismatch=pixelMismatchDiagnostic(error?.pixelMismatch);
        if(error?.attempted!==false||!(['QT_POPUP_CANDIDATE_NOT_UNIQUE','QT_POPUP_UNSTABLE'].includes(error.code)||error.code==='QT_PIXELS_CHANGED'&&mismatch?.stage==='capture'&&mismatch.anchorIndex===0))throw error;
      }
    }
    throw fault('UI_QT_SEARCH_TRANSITION_UNCONFIRMED',{[navigationTransitionFailure]:true});
  }
  async prepareSharedSearch(job,displayedId,baseline,voicePreparation,searchKind=job.target.endsWith('@chatroom')?'group-title':undefined,uiaNavigation,targetLookup){
    baseline??=await this.capture(['header']);
    if(uiaNavigation)baseline=await this.openUiaSearch(baseline,uiaNavigation);
    else await this.sharedAction('chord',{key:'Control+F',...this.popupTransition('search')},['header'],baseline);
    this.surface='search';
    const before=await this.waitForSharedSearchQuery();this.active();
    let pasted;
    try{
      pasted=this.appliedPaste(await this.client.request('paste',{allowClipboardReplacement:this.allowClipboardReplacement,token:before.token,epoch:before.epoch,revision:before.revision,idleMs:this.config.idleMs,text:displayedId,expectedText:displayedId,scope:'search',...(searchKind?{searchKind}:{}),replaceSearch:true,readback:false,...(!this.preparationLease()?{foregroundOnly:true}:{})}),displayedId);
    }catch(error){
      // A refused backup leaves the search open. Confirm its dismissal before
      // offering the queue another attempt to open it.
      if(error.originalClipboardBlocked===true && error.attempted===false && error.clipboardRestored===true &&
          this.preparationLease() && !uiaNavigation && observedLayout(this.config)){
        try{await this.closeObservedSearch(baseline);}
        catch{throw fault('UI_QT_SEARCH_CLOSE_UNVERIFIED',{popupCleanup:{closed:false}});}
      }
      throw error;
    }
    if(pasted.interrupted)throw fault('QT_HUMAN_ACTIVITY_CHANGED',{attempted:false,...clipboardOutcome(pasted)});
    const frame=this.acceptPostPasteFrame(pasted.postPasteFrame,before,['search']),proof=pasted.searchEnterProof,querySha256=crypto.createHash('sha256').update(displayedId).digest('hex');
    if(!object(proof)||Object.keys(proof).length!==3||proof.version!==1||!/^[a-f0-9]{32}$/.test(proof.id??'')||proof.querySha256!==querySha256)throw fault('UI_QT_SEARCH_ENTER_PROOF_INVALID');
    this.active();const entered=await this.client.request('searchEnter',{token:frame.token,epoch:frame.epoch,revision:frame.revision,idleMs:this.config.idleMs,searchEnterProofId:proof.id,querySha256});this.frame=null;
    if(entered.performed!==true||entered.attempted!==true||entered.searchAccepted!==true||entered.revision!==this.transaction.revision)throw fault('UI_QT_SEARCH_ENTER_UNCERTAIN');
    this.surface='main';voicePreparation?.start(baseline);
    const uiaReady=this.config.layoutMode==='uia-v1'&&uiaNavigation&&uiaTargetEvidence(targetLookup)?await this.waitForUiaSearchTransition(job,baseline,targetLookup,frame.popup?.hwnd,entered.searchGeneration):null;
    const opened=uiaReady?.frame??await this.waitForSearchEnterTransition(baseline);
    if(voicePreparation)voicePreparation.readyFrame=opened;
    return Object.freeze({kind:'database-query-search-enter-v1',account:job.account,target:job.target,querySha256,header:this.regionDigest(opened,0),...(uiaReady?{uiaConversationFingerprint:uiaReady.fingerprint,titleSha256:targetLookup.uiaTarget.titleSha256,editorFocused:true}:{}),...(searchKind?{searchKind}:{})});
  }
  assertBackgroundTextFrame(frame,expected,{state='empty',initial=false}={}){
    const lease=this.backgroundTextLease,b=frame?.binding,l=this.config.layout,roles=['header','editor','send'];
    if(this.config.layoutMode!=='uia-v1'||this.navigationPolicy!=='uia-controls-v1'||this.controlVerificationPolicy!=='input-boundaries-v1'||expected.accountRef!==this.config.accountRef||!lease||lease.owner!==this.client||
      frame?.backgroundLeaseId!==lease.id||frame.observationKind!=='uia-background-metadata-v1'||frame.inputTransport!==backgroundTextTransport||frame.pixelsRead!==false||frame.pixelFormat!==undefined||frame.image!=null||frame.popup||frame.navigationOnly===true||frame.editorState!==state||
      !nativeLeaseId(frame.token)||!nativeLeaseId(frame.epoch)||!Number.isSafeInteger(frame.revision)||frame.revision<0||!Number.isFinite(frame.idleMs)||frame.idleMs<this.config.idleMs||
      !object(b)||b.foreground!==false||!positiveDecimal(b.hwnd)||!positiveDecimal(b.processCreatedFileTimeUtc)||!Number.isSafeInteger(b.pid)||b.pid<=0||!Number.isSafeInteger(b.threadId)||b.threadId<=0||b.dpi!==l.dpi||this.config.hwnd!=='auto'&&b.hwnd!==this.config.hwnd||
      !sameRect(b.clientRect,{left:0,top:0,right:l.width,bottom:l.height})||!object(b.captureRect)||!['left','top','right','bottom'].every(k=>Number.isSafeInteger(b.captureRect[k]))||b.captureRect.right-b.captureRect.left!==l.width||b.captureRect.bottom-b.captureRect.top!==l.height||
      !Array.isArray(frame.regions)||frame.regions.length!==3||!roles.every((role,index)=>frame.regions[index]?.role===role&&sameRect(frame.regions[index].rect,l[role])&&hash(frame.regions[index].controlSha256)&&frame.regions[index].rgbaSha256===undefined)||
      !validConversationFingerprint(frame.conversationFingerprint)||!isDeepStrictEqual(frame.conversationFingerprint,expected.uiaConversationFingerprint)||frame.epoch!==expected.epoch||frame.revision!==expected.revision||
      !['hwnd','pid','threadId','processCreatedFileTimeUtc','dpi'].every(k=>b[k]===expected.binding?.[k])||!['clientRect','captureRect'].every(k=>sameRect(b[k],expected.binding?.[k])))throw fault('UI_QT_BACKGROUND_FRAME_UNVERIFIED');
    if(!initial&&(!this.transaction||this.transaction.epoch!==frame.epoch||this.transaction.revision!==frame.revision||this.transaction.pid!==b.pid||this.transaction.created!==b.processCreatedFileTimeUtc))throw fault('UI_QT_HUMAN_ACTIVITY_CHANGED');
    return frame;
  }
  get nativeQuoteAvailable(){return true;}
  get nativeRichQuoteAvailable(){return true;}
  quoteMarker(job){return quoteDraftFile(this.root,this.config.accountRef,job.target);}
  async tryPrepareBackgroundText(job,{textEntryMode,voicePreparation,previous,completedNavigation}={}){
    if(job.quote||fs.existsSync(this.quoteMarker(job)))return false;
    const checkpoint=completedNavigation;
    if(this.allowBackgroundText!==true||this.config.layoutMode!=='uia-v1'||this.navigationPolicy!=='uia-controls-v1'||this.controlVerificationPolicy!=='input-boundaries-v1'||textEntryMode!=='paste'||voicePreparation||this.preparationLease()||this.backgroundTextLease||
      job.index!==0||job.pendingInput||job.image||job.mode==='voice'||!backgroundTextSupported(job.text)||previous?.draft||previous?.imageApplied||previous?.textStage==='pasted'||this.sharedDraftResume||this.draftHold||
      checkpoint?.account!==job.account||checkpoint.target!==job.target||checkpoint.accountRef!==this.config.accountRef||!validConversationFingerprint(checkpoint.uiaConversationFingerprint)||!sharedTargetProof(checkpoint.privateChatProof)||checkpoint.privateChatProof.account!==job.account||checkpoint.privateChatProof.target!==job.target||
      this.now()<checkpoint.verifiedAt||this.now()-checkpoint.verifiedAt>30000)return false;
    const owner=this.client,config=structuredClone(this.config),identity={id:job.id,account:job.account,target:job.target,text:job.text},stepBinding=this.textStepBinding(job);
    let result,readOnlyConfirmed=false;
    try{
      this.active();result=await owner.request('prepareUiaBackgroundText',{idleMs:this.config.idleMs,stepBinding,conversationFingerprint:structuredClone(checkpoint.uiaConversationFingerprint),checkpoint:{epoch:checkpoint.epoch,revision:checkpoint.revision,binding:structuredClone(checkpoint.binding)}});this.active();
      if(result?.ready===false&&result.readOnly===true&&result.inputSent===false&&result.attempted===false&&result.focusChanged===false&&result.clipboardAccessed===false&&/^(?:QT_|DRAFT_)[A-Z0-9_]{1,80}$/.test(result.reason??'')&&!result.backgroundLeaseId)return false;
      if(nativeLeaseId(result?.backgroundLeaseId))this.backgroundTextLease={id:result.backgroundLeaseId,owner};
      if(result?.ready!==true||result.readOnly!==true||result.inputSent!==false||result.attempted!==false||result.focusChanged!==false||result.clipboardAccessed!==false||result.reason!==null||!this.backgroundTextLease)throw fault('UI_QT_BACKGROUND_PREPARE_UNCONFIRMED');
      const frame=this.assertBackgroundTextFrame(result.frame,checkpoint,{initial:true});readOnlyConfirmed=true;
      const account=await this.freshAccount({frame,park:false});validateAccountEvidence(account.evidence,frame.binding,this.now());this.active();
      if(owner!==this.client||!isDeepStrictEqual(config,this.config)||!Object.entries(identity).every(([key,value])=>job[key]===value)||this.now()<checkpoint.verifiedAt||this.now()-checkpoint.verifiedAt>30000)throw fault('UI_QT_BACKGROUND_PREPARE_UNCONFIRMED');
      this.current={jobId:job.id,account:job.account,accountRef:this.config.accountRef,target:job.target,draft:'',epoch:frame.epoch,revision:frame.revision,binding:structuredClone(frame.binding),uiaConversationFingerprint:structuredClone(frame.conversationFingerprint),privateChatProof:structuredClone(checkpoint.privateChatProof),header:frame.regions[0].controlSha256,editor:frame.regions[1].controlSha256,editorToken:crypto.randomUUID(),verifiedAt:this.now(),shared:true,backgroundText:true,draftPolicy:'unchecked',textStage:'focused',stepBinding};
      this.transaction={epoch:frame.epoch,revision:frame.revision,pid:frame.binding.pid,created:frame.binding.processCreatedFileTimeUtc};this.frame=frame;this.surface='main';this.backgroundTextRelease=null;this.textResume=null;return true;
    }catch(error){
      // Unknown native results never authorize a second route. A fresh UIA
      // title alone cannot recover this consumed recipient checkpoint.
      if(!readOnlyConfirmed)this.draftHold={account:job.account,target:job.target};throw error;
    }
  }
  async releaseBackgroundText(){
    const lease=this.backgroundTextLease;if(!lease)return this.backgroundTextRelease??{released:false,backgroundReleased:false,foregroundBorrowed:false,restored:false,skipped:true};
    if(this.current?.backgroundText&&this.current.draft&&this.textSubmitAttempted!==this.current.jobId){this.textResume=this.current;this.draftHold={account:this.current.account,target:this.current.target};}
    this.backgroundTextLease=null;this.current=null;this.frame=null;this.transaction=null;this.surface='main';
    return this.backgroundTextRelease=(async()=>{try{const result=await lease.owner.request('releaseUiaBackgroundText',{backgroundLeaseId:lease.id});
      if(result?.released!==true||result.backgroundLeaseId!==lease.id||result.inputSent!==false||result.focusChanged!==false)throw fault('UI_QT_BACKGROUND_RELEASE_UNCONFIRMED');
      return{released:true,backgroundReleased:true,foregroundBorrowed:false,restored:false,skipped:true,foregroundIntervals:[]};
    }catch(error){this.#completedTextNavigation=null;try{await lease.owner.close();}catch{}throw fault('UI_QT_BACKGROUND_RELEASE_UNCONFIRMED');}})();
  }
  async prepare(job, {signal,textEntryMode='humanized',interactionPlan,[preparedTargetLookup]:backgroundTarget,[sharedVoicePreparation]:voicePreparation} = {}) {
    if(job.quote && ((interactionPlan?.executionMode!=='focus-handoff'&&interactionPlan?.sendMode!=='focus-handoff')||typeof job.quote.text!=='string'||!job.quote.text||job.quote.text.length>4096||!(/^[1-9]\d{0,19}$/).test(job.quote.serverId)))throw fault('UI_QUOTE_TARGET_UNAVAILABLE',{attempted:false,quoteDraftUntouched:true});
    if(!['humanized','paste'].includes(textEntryMode))throw fault('UI_QT_TEXT_ENTRY_MODE_INVALID');
    this.checkJob(job); if (this.busy) throw fault('UI_QT_BUSY');
    const imageDraft=this.current??this.textResume;
    if(imageDraft?.imageApplied)throw fault(imageDraft.jobId===job.id?'UI_QT_IMAGE_RESUME_REQUIRED':'UI_QT_DRAFT_CONFLICT');
    this.busy = true;
    if(!this.backgroundTextLease)this.backgroundTextRelease=null;
    let cleanup,backgroundAccount,backgroundAccountFailure,returnCaptionFailure,borrowedFocus=Boolean(this.preparationLease()),unborrowedForeground=false;const previous=this.current??this.textResume??this.sharedDraftResume,preparationImages=new Set(),completedNavigation=this.#completedTextNavigation;this.#completedTextNavigation=null;this.textResume=null;this.operationSignal=signal;
    const partialResume=Boolean(previous?.shared&&previous.jobId===job.id&&previous.account===job.account&&previous.target===job.target&&(job.index>0||job.pendingInput||previous.textStage==='pasted'));
    const abort=()=>{cleanup??=Promise.resolve(this.client.close());cleanup.catch(()=>{});};
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    try {
      this.active();
      if(this.textSubmitAttempted===job.id)throw fault('UI_QT_TEXT_SUBMIT_UNCERTAIN');
      if(this.draftHold&&!partialResume)throw fault(this.draftHold.account===job.account&&this.draftHold.target===job.target?'UI_QT_PARTIAL_DRAFT_RECHECK_REQUIRED':'UI_QT_DRAFT_CONFLICT');
      if(previous?.shared&&previous.draft&&previous.jobId!==job.id)throw fault('UI_QT_DRAFT_CONFLICT');
      if (previous && (previous.account !== job.account || previous.target !== job.target) && previous.draft) throw fault('UI_QT_DRAFT_CONFLICT');
      if(previous?.backgroundText){
        if(previous===this.current&&previous.jobId===job.id&&previous.account===job.account&&previous.target===job.target&&this.backgroundTextLease){const observed=await this.observe(job);if(observed.ready&&observed.idleMs>=this.config.idleMs)return{ready:true,inputTransport:backgroundTextTransport};}
        throw fault('UI_QT_BACKGROUND_RESUME_UNSUPPORTED');
      }
      if(await this.tryPrepareBackgroundText(job,{textEntryMode,voicePreparation,previous,completedNavigation}))return{ready:true,inputTransport:backgroundTextTransport};
      if(job.quote&&previous===this.current&&previous?.jobId===job.id&&previous.quoteToken){
        if(previous.quoteServerId!==job.quote.serverId||this.preparationLease()?.parked)throw fault('UI_QT_QUOTE_DRAFT_CONFLICT');
        const observed=await this.observe(job);if(!observed.ready)throw fault(observed.reason);
        const f=this.frame,proof=await this.client.request('verifyMessageQuote',{token:f.token,epoch:f.epoch,revision:f.revision,
          idleMs:this.config.idleMs,stepBinding:this.textStepBinding(job),quoteToken:previous.quoteToken});
        if(proof?.verified!==true)throw fault('UI_QT_QUOTE_PREVIEW_UNVERIFIED');
        await this.verifyControlBinding(job,f,'prepare',signal);return {ready:true};
      }
      // A paste already returned the intended prefix and a native one-use
      // submit proof. Do not park or copy that same draft on each tick.
      if(previous===this.current&&previous?.shared&&previous.jobId===job.id&&previous.account===job.account&&previous.target===job.target&&previous.textEnterProof&&!this.preparationLease()?.parked){
        this.nativeTextProof(previous.textEnterProof,previous.draft);const observed=await this.observe(job);
        if(observed.ready&&observed.idleMs>=this.config.idleMs){await this.verifyControlBinding(job,this.frame,'prepare',signal);return{ready:true};}
        await this.releaseTextFocus();
      }
      let targetLookup=backgroundTarget??null;const sharedRequested=observedLayout(this.config)&&Boolean(this.preparationLease()||interactionPlan?.executionMode==='focus-handoff'||interactionPlan?.sendMode==='focus-handoff');
      // Initial contact lookup and model loading are read-only and can finish
      // before borrowing focus. An existing continuation does not re-query.
      if(!targetLookup&&!(job.index>0)&&!job.pendingInput&&(!previous||previous.account!==job.account||previous.target!==job.target||job.target.endsWith('@chatroom')&&previous.jobId!==job.id)){
        if(sharedRequested)targetLookup=await this.lookupTarget(job,{signal});else [,targetLookup]=await Promise.all([this.warmRecognition(signal),this.lookupTarget(job,{signal})]);
      }else if(!sharedRequested)await this.warmRecognition(signal);
      this.active();
      if(targetLookup&&(targetLookup.account!==job.account||targetLookup.target!==job.target||targetLookup.accountRef!==this.config.accountRef))throw fault('UI_QT_TARGET_CHANGED');
      if((interactionPlan?.executionMode==='focus-handoff'||interactionPlan?.sendMode==='focus-handoff')&&!this.textFocusLease){
        if(this.textFocusRelease)await this.textFocusRelease;
        const owner=this.client;
        const preflight=await owner.request('inspectFocusHandoff',{idleMs:this.config.idleMs,width:this.config.layout.width,height:this.config.layout.height,dpi:this.config.layout.dpi});
        if(!object(preflight)||typeof preflight.ready!=='boolean'||preflight.inputSent!==false||preflight.clipboardAccessed!==false||preflight.focusChanged!==false||preflight.ready&&preflight.reason!==null||!preflight.ready&&!/^(?:QT_|DRAFT_)[A-Z0-9_]{1,80}$/.test(preflight.reason??''))throw fault('UI_QT_FOCUS_PREFLIGHT_INVALID');
        if(preflight.ready){
          if(sharedRequested&&!voicePreparation&&!this.resumableTextStep(previous,job)){
            // Process/database inspection does not need foreground. Bind this
            // one preparation to its current geometry, then validate its
            // unchanged 500ms evidence window again after acquiring focus.
            const inspection=await owner.request('inspectLayout'),binding=inspection?.binding,l=this.config.layout;
            if(inspection?.readOnly!==true||inspection.inputSent!==false||inspection.focusChanged!==false||inspection.clipboardAccessed!==false||inspection.executableVersion!==this.config.executableVersion||inspection.executableSha256!==this.config.executableSha256||
              !object(binding)||!sameRect(binding.clientRect,{left:0,top:0,right:l.width,bottom:l.height})||binding.dpi!==l.dpi||!object(binding.captureRect)||!['left','top','right','bottom'].every(key=>Number.isSafeInteger(binding.captureRect[key]))||binding.captureRect.right-binding.captureRect.left!==l.width||binding.captureRect.bottom-binding.captureRect.top!==l.height)throw fault('QT_BINDING_CHANGED');
            const observed=structuredClone(binding);let proof;
            await this.warmUiaLocators({owner,inspection,signal});
            try{proof=await this.freshAccount({frame:{binding:observed},park:false});validateAccountEvidence(proof.evidence,observed,this.now());}
            catch(error){
              // This exact read-only call precedes focus acquisition and all
              // navigation/input. A same-code failure elsewhere has no proof.
              if(!borrowedFocus&&!this.preparationLease()&&!voicePreparation&&!signal?.aborted&&/^(?:UI_ACCOUNT_[A-Z_]+|UI_QT_ACCOUNT_UNVERIFIED)$/.test(error?.code??'')&&error.code!=='UI_ACCOUNT_PROBE_ABORTED')backgroundAccountFailure=error;
              throw error;
            }
            this.active();backgroundAccount={binding:observed,proof};
          }
          let acquired;
          try{acquired=await owner.request('beginFocusHandoff',{idleMs:this.config.idleMs,width:this.config.layout.width,height:this.config.layout.height,dpi:this.config.layout.dpi,includesContactNavigation:observedLayout(this.config)&&!this.resumableTextStep(previous,job),...this.focusActivation()});}
          catch(error){
            // These two codes originate while probing the return caption,
            // before the native focus lease is created or WeChat is activated.
            if(error.attempted===false&&['QT_RETURN_CAPTION_UNAVAILABLE','QT_RETURN_CAPTION_WARMUP'].includes(error.code))returnCaptionFailure=error;
            throw error;
          }
          if(acquired?.activated!==true||!validFocusHandoff(acquired.focusHandoff))throw fault('UI_QT_FOCUS_LEASE_INVALID');
          this.textFocusLease={owner,handoff:structuredClone(acquired.focusHandoff),uiaMode:this.config.layoutMode==='uia-v1',uiaInitialHeaderPending:true};this.textFocusRelease=null;this.foregroundIntervals=[];this.foregroundIntervalsInvalid=false;
          borrowedFocus=true;
        }else if(preflight.reason!=='QT_FOCUS_RETURN_WINDOW_REQUIRED'){
          const error=fault(preflight.reason,{attempted:false});
          if(['QT_RETURN_CAPTION_UNAVAILABLE','QT_RETURN_CAPTION_WARMUP'].includes(preflight.reason))returnCaptionFailure=error;
          throw error;
        }
      }
      this.current = null; this.transaction = null; this.surface='main';
      const resumeStep=this.resumableTextStep(previous,job);
      const settleUiaHeader=!!this.verifyControls&&!resumeStep&&!partialResume&&this.preparationLease()?.uiaInitialHeaderPending===true;
      const uiaNavigation=settleUiaHeader?{lease:this.preparationLease(),started:this.now(),waited:0}:undefined;
      const checkpointMatches=(frame,semantic=false)=>sharedRequested&&!voicePreparation&&!(job.index>0)&&!job.pendingInput&&completedNavigation?.account===job.account&&completedNavigation.target===job.target&&completedNavigation.accountRef===this.config.accountRef&&
        this.now()>=completedNavigation.verifiedAt&&this.now()-completedNavigation.verifiedAt<=30000&&completedNavigation.epoch===frame.epoch&&completedNavigation.revision===frame.revision&&(semantic||completedNavigation.header===this.regionDigest(frame,0))&&
        ['hwnd','pid','threadId','processCreatedFileTimeUtc','dpi'].every(key=>completedNavigation.binding[key]===frame.binding[key])&&['clientRect','captureRect'].every(key=>sameRect(completedNavigation.binding[key],frame.binding[key]));
      let initial,checkpointRejected=false,semanticContinuation=false,uiaReadyFrame,continuationFingerprint;
      if(uiaNavigation&&this.navigationPolicy==='uia-controls-v1'&&completedNavigation){
        initial=await this.captureUiaNavigation();this.assertUiaInitialHeader(uiaNavigation,initial);
        if(checkpointMatches(initial,true)&&validConversationFingerprint(completedNavigation.uiaConversationFingerprint)){
          const proof=await this.verifyControlBinding(job,initial,'navigation-continuation',signal);
          semanticContinuation=validConversationFingerprint(proof?.conversationFingerprint)&&isDeepStrictEqual(proof.conversationFingerprint,completedNavigation.uiaConversationFingerprint);
          if(semanticContinuation)continuationFingerprint=structuredClone(proof.conversationFingerprint);
        }
        // A title fingerprint is only a continuation of this already verified
        // target and activity generation, never independent target identity.
        checkpointRejected=!semanticContinuation;
      }else if(uiaNavigation&&completedNavigation){
        try{initial=await this.capture(['header'],false,{retryPixelChanges:false});this.assertUiaInitialHeader(uiaNavigation,initial);}
        catch(error){const mismatch=pixelMismatchDiagnostic(error?.pixelMismatch);
          if(error?.code!=='QT_PIXELS_CHANGED'||error.attempted!==false||mismatch?.stage!=='capture'||mismatch.anchorIndex!==0)throw error;
        }
        if(initial&&!checkpointMatches(initial))checkpointRejected=true;
        if(!initial||checkpointRejected)initial=await this.stableUiaInitialHeader(uiaNavigation.lease,{context:uiaNavigation});
      }else initial=uiaNavigation?(this.navigationPolicy==='uia-controls-v1'?await this.captureUiaNavigation():await this.stableUiaInitialHeader(uiaNavigation.lease,{context:uiaNavigation,firstOnly:true})):await this.capture(resumeStep?['header','editor']:['header']);
      if(uiaNavigation)uiaNavigation.lease.uiaInitialHeaderPending=false;
      if(backgroundAccount){
        if(!['hwnd','pid','processCreatedFileTimeUtc','dpi'].every(key=>initial.binding[key]===backgroundAccount.binding[key])||!['clientRect','captureRect'].every(key=>sameRect(initial.binding[key],backgroundAccount.binding[key])))throw fault('QT_BINDING_CHANGED');
        if(settleUiaHeader&&this.now()-Date.parse(backgroundAccount.proof.evidence.observedAtUtc)>backgroundAccount.proof.evidence.maximumEvidenceAgeMs){
          backgroundAccount.proof=await this.freshAccount({frame:initial,park:false});this.active();
        }
        validateAccountEvidence(backgroundAccount.proof.evidence,initial.binding,this.now());this.active();
        if(uiaNavigation)uiaNavigation.validateAccount=async frame=>{
          if(this.now()-Date.parse(backgroundAccount.proof.evidence.observedAtUtc)>backgroundAccount.proof.evidence.maximumEvidenceAgeMs)backgroundAccount.proof=await this.freshAccount({frame,park:false});
          validateAccountEvidence(backgroundAccount.proof.evidence,frame.binding,this.now());this.active();
        };
      }
      unborrowedForeground=!borrowedFocus&&!this.preparationLease()&&initial.binding.foreground===true;
      if (initial.idleMs < this.config.idleMs) throw fault('UI_USER_ACTIVE');
      this.transaction = { epoch:initial.epoch,revision:initial.revision,pid:initial.binding.pid,created:initial.binding.processCreatedFileTimeUtc };
      if(resumeStep){const resumed=await this.resumeTextStep(previous,job,initial);if(resumed?.ready===true)await this.verifyControlBinding(job,this.frame,'prepare',signal);return resumed;}
      const shared=sharedRequested,group=job.target.endsWith('@chatroom'),directSearch=shared||group||targetLookup?.searchKind==='private-name'||previous?.account===job.account&&previous.target===job.target&&previous.privateChatProof?.searchKind==='private-name';
      if(this.config.layoutMode==='uia-v1'&&!shared)throw fault('UI_QT_CONTROLS_POLICY_INVALID');
      if(!shared||voicePreparation?.lease!==this.voiceFocusLease)voicePreparation=undefined;
      if(!voicePreparation&&!backgroundAccount)await this.freshAccount(shared?{frame:initial,park:false}:{});
      // A same-contact continuation only keeps its identity if there has been no
      // human activity, process restart or header change since the verified read.
      const recovering=shared&&partialResume;
      if(recovering&&previous.draftPolicy==='unchecked')throw fault('UI_QT_TEXT_STEP_UNAVAILABLE');
      if(recovering&&(!previous.binding||!['hwnd','pid','threadId','processCreatedFileTimeUtc','dpi'].every(key=>initial.binding[key]===previous.binding[key])||!['clientRect','captureRect'].every(key=>sameRect(initial.binding[key],previous.binding[key]))||this.regionDigest(initial,0)!==previous.header||!sharedTargetProof(previous.privateChatProof)))throw fault('UI_QT_PARTIAL_DRAFT_RECHECK_REQUIRED');
      // A completed send retains navigation evidence only, never its body,
      // draft or input token. Reuse it once while this exact window, activity
      // generation and displayed header still match the already acquired frame.
      const completedContinuation=!checkpointRejected&&(semanticContinuation||checkpointMatches(initial));
      let continuation = completedContinuation||previous?.account === job.account && previous.target === job.target && previous.epoch === initial.epoch && previous.revision === initial.revision && previous.header === this.regionDigest(initial,0) && (directSearch?sharedTargetProof(previous.privateChatProof):previous.privateChatProof?.kind==='exact-private-search-row-v1') && previous.privateChatProof.account===job.account && previous.privateChatProof.target===job.target;
      let privateChatProof=completedContinuation?completedNavigation.privateChatProof:continuation||recovering?previous.privateChatProof:null;
      if(completedContinuation){
        if(semanticContinuation){
          const result=await this.sharedAction('focusUiaEditor',{editorRect:this.config.layout.editor},['header'],initial),frame=result.postFocusFrame;
          this.assertTransaction(frame);
          if(result.editorFocused!==true||frame.uiaControlFrame!==true||frame.navigationOnly===true||frame.popup||frame.regions.length!==2||!sameRect(frame.regions[0].rect,this.config.layout.header)||!sameRect(frame.regions[1].rect,this.config.layout.editor)||!['hwnd','pid','threadId','processCreatedFileTimeUtc','dpi'].every(key=>frame.binding[key]===initial.binding[key])||!['clientRect','captureRect'].every(key=>sameRect(frame.binding[key],initial.binding[key])))throw fault('UI_QT_CONTROLS_BINDING_CHANGED');
          this.frame=uiaReadyFrame=frame;
        }else await this.sharedAction('click',{rect:this.config.layout.editor},['header'],initial);
      }
      if(!continuation&&!recovering&&uiaNavigation&&this.config.layoutMode==='uia-v1'&&uiaTargetEvidence(targetLookup)&&targetLookup.uiaTarget.proof==='database-unique-display-name-v1'){
        const currentChat=await this.uiaConversationReady(job,initial,targetLookup);
        if(currentChat.ready){
          voicePreparation?.start(initial);
          const focused=await this.sharedAction('focusUiaEditor',{editorRect:this.config.layout.editor},['header'],initial);
          uiaReadyFrame=this.acceptUiaEditorFocus(focused,initial);if(voicePreparation)voicePreparation.readyFrame=uiaReadyFrame;
          continuationFingerprint=structuredClone(currentChat.proof.conversationFingerprint);continuation=true;
          privateChatProof=Object.freeze({kind:'uia-database-title-v1',account:job.account,target:job.target,querySha256:targetLookup.uiaTarget.querySha256,titleSha256:targetLookup.uiaTarget.titleSha256,header:this.regionDigest(uiaReadyFrame,0),searchKind:targetLookup.searchKind});
        }
      }
      if (!continuation&&!recovering) {
        if(!observedLayout(this.config)&&!rect(this.config.layout.searchResultIdentity))throw fault('UI_QT_SEARCH_IDENTITY_CALIBRATION_REQUIRED');
        if (job.index > 0 || job.pendingInput) throw fault('UI_QT_PARTIAL_DRAFT_RECHECK_REQUIRED');
        const lookup=targetLookup??await this.lookupTarget(job,{signal}),displayedId=lookup.displayedId;
        if(directSearch){
          privateChatProof=await this.prepareSharedSearch(job,displayedId,initial,voicePreparation,lookup.searchKind,uiaNavigation,lookup);
          if(privateChatProof.editorFocused){uiaReadyFrame=this.frame;continuationFingerprint=structuredClone(privateChatProof.uiaConversationFingerprint);}
          else if(!voicePreparation)await this.sharedAction('click',{rect:this.config.layout.editor},['header','editor'],this.frame);
        }
        else{
        let selfMainBaseline;
        const openSelf=async()=>{selfMainBaseline=structuredClone(this.frame);await this.action('click',{rect:this.config.layout.selfOpen,...this.popupTransition('self')},['header','selfOpen'],{stabilizeSelfOpen:true});this.surface='self';};
        const closeSelf=async(captured)=>{if(observedLayout(this.config)&&this.preparationLease()&&this.config.selfCloseKey==='Escape')await this.closeObservedSelfProfile(selfMainBaseline,captured);else if(this.config.selfCloseKey==='Escape')await this.action('chord',{key:'Escape'},['selfAlias']);else await this.action('click',{rect:this.region('selfClose')},['selfAlias']);this.surface='main';};
        await this.withPreparationFocusParked(async()=>{},{includesContactNavigation:true});
        await openSelf();
        const verifiedSelf=await this.profileIdentity('selfAlias',this.config.accountAlias,job.account,{close:closeSelf,reopen:openSelf});
        await closeSelf(verifiedSelf);
        await this.withPreparationFocusParked(async()=>{},{includesContactNavigation:true});
        let searchMainBaseline;
        const adaptiveSearchReadiness=observedLayout(this.config)&&Boolean(this.preparationLease());
        const openSearch=async(expectedSource)=>{
          searchMainBaseline=structuredClone(this.frame);
          await this.action('chord',{key:'Control+F',...this.popupTransition('search')});
          if(this.config.searchPopupCalibration)this.surface='search';
          await this.action('click',{rect:this.config.layout.search},['search'],{settleSearchQuery:adaptiveSearchReadiness&&textEntryMode==='paste'});
          if(textEntryMode==='paste'){
            const pasted=await this.action('paste',{text:displayedId,expectedText:displayedId,scope:'search',replaceSearch:true},['search']);
            if(pasted.performed!==true||pasted.attempted!==true||pasted.searchReplaced!==true||pasted.pasteVerified!==true||!clipboardSettled(pasted,this.allowClipboardReplacement)||pasted.draft!==displayedId)throw fault('UI_QT_PASTE_UNVERIFIED');
          }else {await this.action('chord',{key:'Control+A'},['search']);for(const character of displayedId)await this.action('type',{text:character},['search']);}
          if(adaptiveSearchReadiness&&textEntryMode==='paste')await this.waitForStableSearchResults(searchMainBaseline,{expectedSource});else await this.wait(400);this.active();
        };
        const closeSearch=async()=>{if(adaptiveSearchReadiness)await this.closeObservedSearch(searchMainBaseline);else await this.action('chord',{key:'Escape'},['searchResultIdentity']);this.surface='main';};
        await openSearch();
        privateChatProof=await this.selectPrivateSearchResult(displayedId,job.target,{close:closeSearch,reopen:openSearch,...(adaptiveSearchReadiness&&textEntryMode==='paste'?{captureAndClose:()=>this.captureSearchSourceAndClose(searchMainBaseline)}:{})});
        this.surface='main';
        const adaptive=observedLayout(this.config);
        const mainTitle=adaptive?await this.observeCurrentMainTitle():null;
        if(!adaptive)await this.withPreparationFocusParked(async()=>{},{includesContactNavigation:true});
        let observedPanel,panelBaseline;
        const openProfile=async(initial=false)=>{
          if(adaptive){
            panelBaseline=await this.capture(['header','editor'],true);preparationImages.add(panelBaseline);await this.clickCurrentMainTitle(mainTitle);
            if(this.preparationLease()){
              const opened=await this.capture(['header'],true);let closed;
              try{
                // The adaptive main locator proves the exact title toggle.
                // Its pixels must remain the original title before closing a
                // newly opened side panel, so CV can run with focus returned.
                if(this.regionDigest(opened,0)!==this.regionDigest(panelBaseline,0))throw fault('UI_QT_CONTACT_PANEL_CHANGED');
                closed=await this.clickCurrentMainTitle(mainTitle,{closedBaseline:panelBaseline});
                await this.withPreparationFocusParked(async()=>{
                  [observedPanel]=await Promise.all([this.observedContactPanel(opened),this.verifyObservedPanelClosed(panelBaseline,{captured:closed,park:false})]);
                  if(!sameRect(observedPanel.closeRect,mainTitle.titleRect)||observedPanel.closeRgbaSha256!==mainTitle.titleRgbaSha256)throw fault('UI_QT_CONTACT_PANEL_UNVERIFIED');
                },{includesContactNavigation:true});
                const fresh=await this.capture(['header','editor']);if(!this.panelClosedFrameMatches(panelBaseline,fresh))throw fault('UI_QT_CONTACT_PANEL_CLOSE_UNVERIFIED');
                await this.clickCurrentMainTitle(mainTitle);
              }finally{
                for(const saved of [opened,closed]){const file=saved?.image?.file;if(typeof file==='string'&&path.dirname(file)===path.join(this.root,'state/ui-host/qt-frames')&&fs.existsSync(file)){noLinks(file);fs.unlinkSync(file);}}
              }
            }else{observedPanel=await this.observedContactPanel();if(!sameRect(observedPanel.closeRect,mainTitle.titleRect)||observedPanel.closeRgbaSha256!==mainTitle.titleRgbaSha256)throw fault('UI_QT_CONTACT_PANEL_UNVERIFIED');}
            await this.clickObservedPanel(observedPanel,'member',{transition:true});
          }
          else {if(initial||!this.config.layout.profileMember)await this.action('click',{rect:this.config.layout.profileOpen,...(!this.config.layout.profileMember?this.popupTransition('profile'):{})},['header','profileOpen']);
          if(this.config.layout.profileMember)await this.action('click',{rect:this.config.layout.profileMember,...this.popupTransition('profile')},['header','profileMember']);}
          this.surface='profile';
        };
        const closeProfile=async(captured)=>{if(captured)await this.closeVerifiedProfile(captured);else if(this.config.profileCloseKey==='Escape')await this.action('chord',{key:'Escape'},['profileAlias']);else await this.action('click',{rect:this.region('profileClose')},['profileAlias']);this.surface='main';};
        const closePanel=async()=>{if(adaptive){const captured=await this.clickObservedPanel(observedPanel,'close',this.preparationLease()?{closedBaseline:panelBaseline}:{});await this.verifyObservedPanelClosed(panelBaseline,{captured});}else if(this.config.layout.profilePanelClose)await this.action('click',{rect:this.config.layout.profilePanelClose});};
        const closeProfileForBackground=async()=>{await closeProfile();await closePanel();};
        await openProfile(true);
        const verifiedProfile=await this.profileIdentity('profileAlias',displayedId,job.target,{close:closeProfileForBackground,reopen:()=>openProfile(true)});
        await closeProfile(verifiedProfile);
        await closePanel();
        await this.action('click',{rect:this.config.layout.editor});
        }
      }
      if(!shared)await this.withPreparationFocusParked(async()=>{});
      const verified = shared?{draft:previous?.jobId===job.id&&continuation?previous.draft:'',frame:uiaReadyFrame===this.frame&&uiaReadyFrame||voicePreparation&&voicePreparation.readyFrame===this.frame?this.frame:await this.capture(['header','editor']),draftPolicy:'unchecked'}:await this.readDraft(job);
      if(voicePreparation){
        voicePreparation.start(verified.frame);
        const settled=await voicePreparation.pending;if(settled.error)throw settled.error;
        const proof=settled.proof;
        if(proof?.accountRef!==this.config.accountRef||proof.accountScopeHash!==this.config.accountRef)throw fault('UI_QT_ACCOUNT_UNVERIFIED');
        validateAccountEvidence(proof.evidence,verified.frame.binding,this.now());this.active();this.assertTransaction(verified.frame);
        voicePreparation.proof=proof;
      }
      await this.verifyControlBinding(job,verified.frame,'prepare',signal);
      const marker=this.quoteMarker(job);
      if(fs.existsSync(marker)){
        noLinks(marker);
        const old=JSON.parse(fs.readFileSync(marker,'utf8'));
        let clear;
        if(this.config.layoutMode==='uia-v1'||old.mode==='uia'){
          const f=verified.frame;
          clear=(await this.client.request('checkClearMessageQuote',{token:f.token,epoch:f.epoch,revision:f.revision,idleMs:this.config.idleMs})).clear===true;
        }else if(old.bound===true && old.mode==='ocr'){
          const {verifyNoOcrQuote}=await import('./qt-quote-ocr.mjs');
          clear=await verifyNoOcrQuote(this,job,verified.frame,signal);
        }
        if(clear!==true)throw fault('UI_QT_QUOTE_DRAFT_CONFLICT');
        confirmQuoteDraftSent(this.root,this.config.accountRef,job.target,old.id);
        verified.frame=await this.capture(['header','editor']);
      }
      let quoteToken;
      if(job.quote){
        if(!shared||!this.preparationLease()||verified.draft||job.pendingInput||job.index>0)throw fault('UI_QT_QUOTE_DRAFT_CONFLICT');
        const mode=this.config.layoutMode==='uia-v1'?'uia':'ocr';
        fs.mkdirSync(path.dirname(marker),{recursive:true});
        noLinks(marker);
        const fd=fs.openSync(marker,'wx');
        try{fs.writeFileSync(fd,JSON.stringify({id:job.id,bound:false,mode}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
        let attachment;
        try{
          attachment=await this.attachMessageQuote(job,verified.frame,signal);
        }catch(error){
          if(error.quoteDraftUntouched===true&&error.attempted===false)confirmQuoteDraftSent(this.root,this.config.accountRef,job.target,job.id);
          throw error;
        }
        const temporary=marker+'.'+crypto.randomUUID()+'.tmp';
        try{fs.writeFileSync(temporary,JSON.stringify({id:job.id,bound:true,mode:attachment.mode??mode}),{flag:'wx',flush:true});fs.renameSync(temporary,marker);}
        finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
        quoteToken=attachment.quoteToken;
        if(this.config.layoutMode==='uia-v1'){
          this.originalQuoteEditorRect??=this.config.layout.editor;
          this.config.layout.editor=attachment.editorRect;
        }
        verified.frame=await this.capture(['header','editor']);
        await this.verifyControlBinding(job,verified.frame,'prepare',signal);
      }
      this.current = { jobId:job.id,account:job.account,target:job.target,draft:verified.draft,epoch:verified.frame.epoch,revision:verified.frame.revision,binding:structuredClone(verified.frame.binding),...(continuationFingerprint?{uiaConversationFingerprint:continuationFingerprint}:{}),
        header:this.regionDigest(verified.frame,0),editor:this.regionDigest(verified.frame,1),editorToken:crypto.randomUUID(),verifiedAt:this.now(),privateChatProof,shared,textEntryMode,...(shared?{draftPolicy:'unchecked',textStage:'focused'}:{}),textEnterProof:verified.textEnterProof,...(shared&&verified.textEnterProof?{textStage:'pasted',stepBinding:this.textStepBinding(job)}:{}),verifiedEmptyHashes:verified.verifiedEmptyHashes,emptyDraftPhaseProof:verified.emptyDraftPhaseProof,verifiedEmptyPhase:verified.verifiedEmptyPhase };
      this.sharedDraftResume=null;if(recovering)this.draftHold=null;
      if(quoteToken){this.current.quoteToken=quoteToken;this.current.quoteServerId=job.quote.serverId;}
      return { ready:true };
    } catch (error) {
      // Retain the original transaction until its own profile popup has been
      // safely dismissed. Resetting the surface first loses that authority and
      // leaves the foreground lease unable to return focus from an open popup.
      const failedSurface=this.surface;
      let popupCleanupUnattempted=false;
      try{if(!error?.[verifiedProfileCloseFailure]){const cleanup=await this.closePreparationPopupAfterFailure();popupCleanupUnattempted=cleanup.attempted===false;if(cleanup.attempted)error.popupCleanup=cleanup;}}
      catch(cleanupError){error.popupCleanup={closed:false,code:codeFor(cleanupError)};}
      // Losing the verified session must not erase knowledge of an existing
      // draft. In particular a later tick cannot navigate another chat after a
      // draft conflict or silently continue a partially typed message.
      if(previous?.draft)this.draftHold={account:previous.account,target:previous.target};
      else if(job.index>0||job.pendingInput)this.draftHold={account:job.account,target:job.target};
      if(previous?.shared&&this.textSubmitAttempted!==job.id&&(previous.draft||job.index>0||job.pendingInput))this.sharedDraftResume=previous;
      this.current=null;this.frame=null;this.transaction=null;this.surface='main';
      const returned=await this.releaseTextFocus();
      if(error.quoteDraftUntouched && (error.popupCleanup?.closed===false || borrowedFocus && !(returned?.released===true && returned.restored && !returned.skipped)))delete error.quoteDraftUntouched;
      if(error.originalClipboardBlocked===true && error.attempted===false && error.clipboardRestored===true &&
          (error.popupCleanup?.closed===true || failedSurface==='main' && popupCleanupUnattempted) &&
          !voicePreparation && !this.preparationLease() && !cleanup && !signal?.aborted && !error.controlsCleanupFailed &&
          job.index===0 && !job.pendingInput && !previous?.draft && !previous?.imageApplied && previous?.textStage!=='pasted' &&
          !this.draftHold && this.textSubmitAttempted!==job.id &&
          (borrowedFocus ? returned?.released===true && returned.restored===true && returned.skipped===false : unborrowedForeground))
        return {ready:false,reason:codeFor(error),clipboardPreparationClean:true};
      if(returnCaptionFailure===error&&!borrowedFocus&&!this.preparationLease()&&!voicePreparation&&!signal?.aborted&&!cleanup&&
          failedSurface==='main'&&popupCleanupUnattempted&&error.attempted===false&&error.inputSent!==true&&
          error.clipboardRestored!==false&&!error.controlsCleanupFailed&&error.popupCleanup?.closed!==false&&
          job.index===0&&!job.pendingInput&&!previous?.draft&&!previous?.imageApplied&&previous?.textStage!=='pasted'&&
          !this.draftHold&&this.textSubmitAttempted!==job.id)
        return {ready:false,reason:codeFor(error),attempted:false,focusPreflightClean:true};
      const uiaRefusal=error?.[uiaVerificationRefusal];
      if(uiaRefusal&&!voicePreparation&&!this.preparationLease()&&!signal?.aborted&&!cleanup&&job.index===0&&!job.pendingInput&&!previous?.draft&&!previous?.imageApplied&&previous?.textStage!=='pasted'&&!this.draftHold&&this.textSubmitAttempted!==job.id&&
        error.attempted===false&&error.inputSent!==true&&!error.controlsCleanupFailed&&error.clipboardRestored!==false&&error.popupCleanup?.closed!==false&&
        (uiaRefusal.focus==='restored'||!borrowedFocus&&uiaRefusal.focus==='not-borrowed'))
        error.uiaPreparationRefusal={version:1,stage:'control-preparation',operation:uiaRefusal.operation,focus:uiaRefusal.focus,messageInputAttempted:false,draftPresent:false,cleanupConfirmed:true};
      if(backgroundAccountFailure===error&&!borrowedFocus&&!this.preparationLease()&&!voicePreparation&&!signal?.aborted&&popupCleanupUnattempted&&error.attempted!==true&&error.inputSent!==true&&error.clipboardRestored!==false&&error.popupCleanup?.closed!==false)
        error.accountPreflightRefusal={version:1,stage:'background-account',focusBorrowed:false,voiceLeasePresent:false,messageInputAttempted:false,cleanupRequired:false};
      // A failed contact-navigation observation never submitted a chat body.
      // Only a confirmed return (or a session that never borrowed focus) lets
      // the queue pause this delivery while its message reader keeps running.
      // A shared voice lease is still owned by the outer voice preparation.
      if(!this.preparationLease()){
        if(borrowedFocus&&returned?.released===true&&returned.restored===true&&returned.skipped===false)markNavigationRefusal(error,'restored');
        else if(unborrowedForeground)markNavigationRefusal(error,'not-borrowed');
      }
      if(preparationWaits.has(codeFor(error))&&error?.clipboardRestored!==false)return {ready:false,reason:codeFor(error)};
      throw error;
    }
    finally { for(const frame of preparationImages)this.discardNativeFrameImage(frame);signal?.removeEventListener('abort',abort);this.operationSignal=null;this.busy=false;if(cleanup){await cleanup;this.current=null;this.frame=null;this.transaction=null;if(!this.closed)this.client=this.clientFactory();} }
  }
  async attachMessageQuote(job,frame,signal){
    this.active();
    let attached;
    try{
      if(this.config.layoutMode==='uia-v1'||job.quote.locator){
        try{
          attached=await this.client.request('attachMessageQuote',{token:frame.token,epoch:frame.epoch,revision:frame.revision,idleMs:this.config.idleMs,
            stepBinding:this.textStepBinding(job),quoteText:job.quote.text,fromSelf:job.quote.sender===job.account,
            ...(job.quote.locator?{quoteKind:job.quote.kind,quoteLocator:job.quote.locator}:{})});
          attached={...attached,mode:'uia'};
        }catch(error){
          if(this.config.layoutMode==='uia-v1'||error.attempted!==false||!['QT_UIA_CONTROL_ROOT_INVALID','QT_UIA_CONTROL_UNAVAILABLE'].includes(error.code))throw error;
        }
      }
      if(!attached){
        const {attachOcrQuote}=await import('./qt-quote-ocr.mjs');
        attached=await attachOcrQuote(this,job,frame,signal);
      }
    }catch(error){
      if(error.attempted===false&&['QT_QUOTE_SOURCE_NOT_VISIBLE','QT_QUOTE_SOURCE_AMBIGUOUS','QT_QUOTE_SOURCE_OBSCURED','QT_UIA_CONTROL_ROOT_INVALID','QT_UIA_CONTROL_UNAVAILABLE'].includes(error.code))
        throw fault('UI_QUOTE_TARGET_UNAVAILABLE',{attempted:false,quoteDraftUntouched:true});
      throw error;
    }
    if(signal?.aborted||attached?.attached!==true||!/^[a-f0-9]{32}$/.test(attached.quoteToken)||!rect(attached.editorRect))throw fault('UI_QT_QUOTE_PREVIEW_UNVERIFIED');
    return attached;
  }
  releaseTextFocus() {
    if(this.originalQuoteEditorRect){this.config.layout.editor=this.originalQuoteEditorRect;this.originalQuoteEditorRect=null;}
    if(this.backgroundTextLease)return this.releaseBackgroundText();
    if(this.backgroundTextRelease&&!this.textFocusLease)return this.backgroundTextRelease;
    if(!this.textFocusLease)return this.textFocusRelease??Promise.resolve({released:false,restored:false,skipped:true});
    const {owner,parked}=this.textFocusLease;this.textFocusLease=null;
    // Keep the completed-input checkpoint for an explicit same-job resume;
    // observation remains blocked until the original window is reacquired.
    this.textResume=this.current;
    this.current=null;this.frame=null;this.transaction=null;this.surface='main';
    return this.textFocusRelease=(async()=>{
      try{
        const result=await owner.request('releaseFocusHandoff');
        if(result?.restored!==true||result?.skipped===true)this.#completedTextNavigation=null;
        if(result?.restored!==true&&result?.skipped!==true)throw fault('UI_QT_FOCUS_RETURN_UNCONFIRMED',focusReturnDiagnostics(result));
        if(result.foregroundInterval!==undefined)this.addForegroundInterval(result.restored===true&&result.skipped!==true?result.foregroundInterval:incompleteForegroundInterval(result.foregroundInterval));
        else if(!parked)this.foregroundIntervalsInvalid=true;
        const foregroundIntervals=this.completedForegroundIntervals();
        if(foregroundIntervals?.length)recordForegroundTiming({root:this.root,timing:makeForegroundTiming({operation:'text',preparationIntervals:foregroundIntervals})});
        const focusRestoreOutcome=focusRestoreOutcomeDiagnostic(result.focusRestoreOutcome);
        return{released:true,restored:result.restored===true,skipped:result.skipped===true,...(foregroundIntervals?{foregroundIntervals}:{}),...(focusRestoreOutcome?{focusRestoreOutcome}:{})};
      }catch(error){
        // A failed cleanup is still a failed cleanup. Its measured prefix must
        // replace the previous complete timing, without claiming we observed
        // the end of focus ownership or authorizing another input attempt.
        this.#completedTextNavigation=null;
        if(error?.foregroundInterval!==undefined)this.addForegroundInterval(incompleteForegroundInterval(error.foregroundInterval));
        else this.foregroundIntervalsInvalid=true;
        const foregroundIntervals=this.completedForegroundIntervals();
        if(foregroundIntervals?.length)recordForegroundTiming({root:this.root,timing:makeForegroundTiming({operation:'text',preparationIntervals:foregroundIntervals})});
        try{await owner.close();}catch{}
        throw fault('UI_QT_FOCUS_RETURN_UNCONFIRMED',{...focusReturnDiagnostics(error),...(foregroundIntervals?{foregroundIntervals}:{})});
      }
    })();
  }
  async observe(job) {
    this.checkJob(job); const current = this.current;
    if (!current || current.account !== job.account || current.target !== job.target || this.now()-current.verifiedAt > 30000) return { ready:false,reason:'UI_QT_PREPARATION_REQUIRED' };
    try {
      if(current.backgroundText===true){
        this.assertBackgroundTextFrame(this.frame,current,{state:current.draft?'own-text':'empty'});
        return{ready:true,account:job.account,target:job.target,foreground:false,inputTransport:backgroundTextTransport,inputEnabled:true,idleMs:this.frame.idleMs,draft:current.draft,draftPolicy:'unchecked',editorToken:current.editorToken,activityRevision:current.revision};
      }
      if(current.fileDialogProof&&current.imageApplied===job.id&&job.mode==='file')return {ready:true,appliedImageId:job.id,editorToken:current.editorToken,activityRevision:current.revision};
      if(current.imageApplied===job.id){
        if(this.config.layoutMode==='uia-v1'){
          if(!validUiaImageProof(current.uiaImageProof,job.image)||this.imageSubmitAttempted===job.id||this.frame!==current.uiaImageFrame)return{ready:false,reason:'UI_QT_IMAGE_APPLICATION_UNKNOWN'};
          this.acceptUiaImageFrame(this.frame,current);
          // This reports the retained paste intent, not attachment contents.
          // Fresh UIA and native activity checks still precede the next input.
          return{ready:true,account:job.account,target:job.target,foreground:true,inputEnabled:true,idleMs:this.frame.idleMs,editorToken:current.editorToken,activityRevision:current.revision,appliedImageId:job.id};
        }
        const frame=await this.capture(['header',current.imageFormat==='gif'?'send':'editor']);
        if(this.regionDigest(frame,0)!==current.header)return {ready:false,reason:'UI_QT_HEADER_CHANGED'};
        return {ready:true,account:job.account,target:job.target,foreground:true,inputEnabled:true,idleMs:frame.idleMs,editorToken:current.editorToken,activityRevision:current.revision,appliedImageId:job.id};
      }
      if(current.draftPolicy==='unchecked'){
        if(!this.frame||this.surface!=='main')return{ready:false,reason:'UI_QT_PREPARATION_REQUIRED'};
        this.assertTransaction(this.frame);
        // This is this delivery's applied input prefix, not copied editor text.
        // The next native input validates actual focus and activity itself.
        return{ready:true,account:job.account,target:job.target,foreground:true,inputEnabled:true,idleMs:this.frame.idleMs,draft:current.draft,draftPolicy:'unchecked',editorToken:current.editorToken,activityRevision:current.revision};
      }
      const frame = await this.capture(['header','editor']);
      if (this.regionDigest(frame,0) !== current.header || this.regionDigest(frame,1) !== current.editor) return { ready:false,reason:'UI_QT_DRAFT_RECHECK_REQUIRED' };
      return { ready:true,account:job.account,target:job.target,foreground:true,inputEnabled:true,idleMs:frame.idleMs,draft:current.draft,editorToken:current.editorToken,activityRevision:current.revision };
    } catch (error) { return { ready:false,reason:codeFor(error) }; }
  }
  async sendAction(action,job,guard,local={}) {
    if(local.beforeSubmit!==undefined&&(action!=='submit'||typeof local.beforeSubmit!=='function'))throw fault('UI_RECEIPT_BARRIER_INVALID');
    this.#completedTextNavigation=null;
    this.checkJob(job); const current = this.current;
    if(action==='paste'&&(typeof guard?.text!=='string'||!guard.text||guard.text.length>16000||guard.text.includes('\0')))return {performed:false,attempted:false,reason:'UI_QT_PASTE_INVALID'};
    if (!current || current.account !== job.account || current.target !== job.target || guard?.expectedDraft !== current.draft || guard.editorToken !== current.editorToken || guard.activityRevision !== current.revision) return { performed:false,attempted:false,reason:'UI_QT_DRAFT_CHANGED' };
    if (action === 'submit' && !this.allowSubmit) return { performed:false,attempted:false,reason:'UI_SUBMIT_DISABLED' };
    if((job.quote||current.quoteToken)&&(!job.quote||!current.quoteToken||current.quoteServerId!==job.quote.serverId||!current.shared||current.backgroundText))return {performed:false,attempted:false,reason:'UI_QT_QUOTE_PREVIEW_UNVERIFIED'};
    if(action === 'type' && guard.text === '\n' && this.config.newlineKey !== 'Shift+Enter')return {performed:false,attempted:false,reason:'UI_QT_NEWLINE_CALIBRATION_REQUIRED'};
    if(current.backgroundText===true)return this.sendBackgroundTextAction(action,job,guard,current,local);
    let attempted = false, inputAccepted = false;
    try {
      // Shared preparation already proved this account/process transaction.
      // Parking focus here would revoke the one-use post-paste native proof.
      if(!current.shared)await this.freshAccount();
      const observation = await this.observe(job);
      if (observation.ready !== true) return { performed:false,attempted:false,reason:observation.reason };
      if (typeof guard.canSubmit === 'function' && action === 'submit' && !guard.canSubmit()) return { performed:false,attempted:false,reason:'UI_TARGET_NOT_ALLOWED' };
      if((action==='paste'||action==='type')&&typeof guard.canInput!=='function')return {performed:false,attempted:false,reason:'UI_QT_INPUT_AUTHORIZATION_REQUIRED'};
      const frame = this.frame;
      await this.verifyControlBinding(job,frame,action==='submit'?'text-submit':'text-input',guard.signal);
      if(action==='submit'&&local.beforeSubmit){
        const receipt=await local.beforeSubmit();
        if(!object(receipt)||Object.keys(receipt).length!==2||receipt.ready!==true||receipt.proof!=='receipt-baseline-persisted-v1')throw fault('UI_RECEIPT_BARRIER_UNCONFIRMED');
        // The receipt wait grants no UI authority. The original transaction,
        // current permission and native one-use frame still govern input.
        this.active();this.assertTransaction(frame);
        if(guard.signal?.aborted)throw fault('UI_QT_CANCELLED');
      }
      this.active();
      if(action==='submit'&&typeof guard.canSubmit==='function'&&guard.canSubmit()!==true)return {performed:false,attempted:false,reason:'UI_TARGET_NOT_ALLOWED'};
      if((action==='paste'||action==='type')&&guard.canInput()!==true)return {performed:false,attempted:false,reason:'UI_TARGET_NOT_ALLOWED'};
      // Keep the outbox's write-ahead intent authoritative. Any failure after
      // entering native input remains uncertain; this layer never retries.
      const typed=action==='type'&&current.shared===true&&current.draftPolicy==='unchecked',enterSubmit=action==='submit'&&current.shared===true,textProof=enterSubmit||typed&&current.draft?this.nativeTextProof(current.textEnterProof,current.draft):undefined;
      attempted = true;
      const result = await this.client.request(action === 'submit' ? enterSubmit?'submitTextEnter':'click' : typed?'typeText':action, { ...(current.quoteToken?{quoteToken:current.quoteToken}:{}),token:frame.token,epoch:frame.epoch,revision:frame.revision,idleMs:this.config.idleMs,
        ...(action === 'submit' ? enterSubmit?{textEnterProofId:textProof.id,textSha256:textProof.textSha256,stepBinding:this.textStepBinding(job),headerRect:this.config.layout.header,editorRect:this.config.layout.editor,...(this.allowBackgroundText===true&&!current.quoteToken?{retainBackgroundEditor:true}:{})}:{rect:this.config.layout.send} : action==='paste'?{allowClipboardReplacement:this.allowClipboardReplacement,text:guard.text,expectedText:current.draft+guard.text,scope:'editor',...(current.shared?{headerRect:this.config.layout.header,editorRect:this.config.layout.editor,stepBinding:this.textStepBinding(job),...(current.draftPolicy==='unchecked'?{readback:false,...(!this.preparationLease()?{foregroundOnly:true}:{})}:{})}:{})}:{text:guard.text,...(typed?{expectedText:current.draft+guard.text,headerRect:this.config.layout.header,editorRect:this.config.layout.editor,stepBinding:this.textStepBinding(job),...(!this.preparationLease()?{foregroundOnly:true}:{}),...(textProof?{textEnterProofId:textProof.id}:{})}:{}),...(guard.text === '\n' ? {newlineKey:this.config.newlineKey} : {})}) });
      inputAccepted = true;
      if(action==='submit'){this.textSubmitAttempted=job.id;this.textResume=null;this.sharedDraftResume=null;}
      this.frame = null; this.current = null;
      if (result.attempted !== true || result.performed !== true) throw fault('UI_QT_INPUT_UNCERTAIN');
      if(enterSubmit&&result.submittedViaEnter!==true)throw fault('UI_QT_INPUT_UNCERTAIN');
      if (action === 'type'||action==='paste') {
        const fast=(action==='paste'||typed)&&current.draftPolicy==='unchecked',expected=current.draft+guard.text;
        if(fast){
          if(typed)this.appliedTypedText(result,expected);else this.appliedPaste(result,expected);
          if(result.interrupted){
            if(result.postPasteFrame!==undefined)throw fault('UI_QT_PASTE_UNCONFIRMED');
            this.current={...current,draft:expected,textStage:'pasted',stepBinding:this.textStepBinding(job),textEnterProof:this.nativeTextProof(result.textEnterProof,expected),editorToken:crypto.randomUUID(),verifiedAt:this.now()};
            this.sharedDraftResume=this.current;await this.releaseTextFocus();return{performed:true,attempted:true};
          }
        }else if(action==='paste'&&(result.pasteVerified!==true||!clipboardSettled(result,this.allowClipboardReplacement)||result.draft!==expected))throw fault('UI_QT_PASTE_UNVERIFIED');
        const verified = (action==='paste'||typed)&&current.shared?{draft:fast?expected:result.draft,frame:this.acceptPostPasteFrame(result.postPasteFrame,frame,['header','editor'],fast?{conversationFingerprint:current.uiaConversationFingerprint}:{}),textEnterProof:this.nativeTextProof(result.textEnterProof,fast?expected:result.draft)}:await this.readDraft(job);
        this.current = { ...current,draft:verified.draft,binding:structuredClone(verified.frame.binding),header:this.regionDigest(verified.frame,0),editor:this.regionDigest(verified.frame,1),editorToken:crypto.randomUUID(),verifiedAt:this.now(),textEnterProof:verified.textEnterProof,...(current.shared&&verified.textEnterProof?{textStage:'pasted',stepBinding:this.textStepBinding(job)}:{}),verifiedEmptyHashes:verified.verifiedEmptyHashes,emptyDraftPhaseProof:verified.emptyDraftPhaseProof,verifiedEmptyPhase:verified.verifiedEmptyPhase };
      }
      if(action==='submit'&&current.shared&&sharedTargetProof(current.privateChatProof)&&current.privateChatProof.account===job.account&&current.privateChatProof.target===job.target){
        const binding=Object.fromEntries(['hwnd','pid','threadId','processCreatedFileTimeUtc','dpi'].map(key=>[key,current.binding[key]]));
        for(const key of ['clientRect','captureRect'])binding[key]=structuredClone(current.binding[key]);
        this.#completedTextNavigation={account:job.account,target:job.target,accountRef:this.config.accountRef,epoch:current.epoch,revision:current.revision,binding,header:current.header,verifiedAt:this.now(),privateChatProof:structuredClone(current.privateChatProof),...(validConversationFingerprint(current.uiaConversationFingerprint)?{uiaConversationFingerprint:structuredClone(current.uiaConversationFingerprint)}:{})};
      }
      return { performed:true,attempted:true };
    } catch (error) {
      if(error?.controlsCleanupFailed)throw error;
      const definitelyUnattempted=!attempted||!inputAccepted&&error?.attempted===false&&(error.clipboardRestored!==false||clipboardSettled(error,this.allowClipboardReplacement));
      if(action==='submit'&&!definitelyUnattempted){this.textSubmitAttempted=job.id;this.textResume=null;this.sharedDraftResume=null;}
      else if(current?.shared&&(current.draft||attempted))this.sharedDraftResume=current;
      this.current = null; this.frame = null;
      if (definitelyUnattempted) return { performed:false,attempted:false,reason:codeFor(error) };
      throw fault(codeFor(error));
    }
  }
  async sendBackgroundTextAction(action,job,guard,current,local={}){
    if(!['paste','submit'].includes(action)||action==='paste'&&(current.draft!==''||current.textStage!=='focused'||guard.text!==job.text||!backgroundTextSupported(guard.text)))return{performed:false,attempted:false,reason:'UI_QT_BACKGROUND_TEXT_UNSUPPORTED'};
    if(action==='submit'&&(current.draft!==job.text||this.textSubmitAttempted===job.id))return{performed:false,attempted:false,reason:'UI_QT_TEXT_SUBMIT_UNCERTAIN'};
    if(typeof (action==='submit'?guard.canSubmit:guard.canInput)!=='function')return{performed:false,attempted:false,reason:'UI_QT_INPUT_AUTHORIZATION_REQUIRED'};
    const lease=this.backgroundTextLease,frame=this.frame,identity={id:job.id,account:job.account,target:job.target,text:job.text};let attempted=false,accepted=false;
    try{
      this.active();if(guard.signal?.aborted)throw fault('UI_QT_CANCELLED');this.assertBackgroundTextFrame(frame,current,{state:current.draft?'own-text':'empty'});
      const proof=action==='submit'?this.nativeTextProof(current.textEnterProof,current.draft):undefined;
      if(action==='submit'&&local.beforeSubmit){const receipt=await local.beforeSubmit();if(!object(receipt)||Object.keys(receipt).length!==2||receipt.ready!==true||receipt.proof!=='receipt-baseline-persisted-v1')throw fault('UI_RECEIPT_BARRIER_UNCONFIRMED');}
      this.active();if(guard.signal?.aborted)throw fault('UI_QT_CANCELLED');
      if(this.current!==current||this.frame!==frame||this.backgroundTextLease!==lease||!Object.entries(identity).every(([key,value])=>job[key]===value))throw fault('UI_QT_BACKGROUND_FRAME_UNVERIFIED');
      this.assertBackgroundTextFrame(frame,current,{state:current.draft?'own-text':'empty'});
      if((action==='submit'?guard.canSubmit():guard.canInput())!==true)return{performed:false,attempted:false,reason:'UI_TARGET_NOT_ALLOWED'};
      attempted=true;const result=await lease.owner.request(action==='submit'?'submitUiaBackgroundText':'writeUiaBackgroundText',{backgroundLeaseId:lease.id,token:frame.token,epoch:frame.epoch,revision:frame.revision,idleMs:this.config.idleMs,stepBinding:this.textStepBinding(job),...(action==='submit'?{textEnterProofId:proof.id,textSha256:proof.textSha256}:{text:guard.text,expectedText:guard.text})});accepted=true;
      if(action==='submit')this.textSubmitAttempted=job.id;
      if(result?.performed!==true||result.attempted!==true)throw fault('UI_QT_BACKGROUND_INPUT_UNCERTAIN');
      if(action==='paste'){
        if(result.textTransport!==backgroundTextTransport||result.valueConfirmed!==true||result.clipboardAccessed!==false||result.readbackPerformed!==false||result.intendedText!==guard.text||result.interrupted!==false)throw fault('UI_QT_BACKGROUND_INPUT_UNCERTAIN');
        const next=this.assertBackgroundTextFrame(result.postPasteFrame,current,{state:'own-text'}),textEnterProof=this.nativeTextProof(result.textEnterProof,guard.text);
        this.frame=next;this.current={...current,draft:guard.text,binding:structuredClone(next.binding),header:next.regions[0].controlSha256,editor:next.regions[1].controlSha256,editorToken:crypto.randomUUID(),verifiedAt:this.now(),textStage:'pasted',textEnterProof};
      }else{
        if(result.inputQueued!==true||result.submissionConfirmed!==false||result.submitted===true||result.messagesPosted!==3||result.inputTransport!==backgroundTextTransport||result.foregroundChanged!==false||result.clipboardAccessed!==false||result.editorEmptyAfterSubmit!==true||result.consumptionConfirmed!==true)throw fault('UI_QT_BACKGROUND_INPUT_UNCERTAIN');
        const binding=Object.fromEntries(['hwnd','pid','threadId','processCreatedFileTimeUtc','dpi','clientRect','captureRect'].map(key=>[key,structuredClone(current.binding[key])]));
        this.#completedTextNavigation={account:job.account,target:job.target,accountRef:this.config.accountRef,epoch:current.epoch,revision:current.revision,binding,header:current.header,verifiedAt:this.now(),privateChatProof:structuredClone(current.privateChatProof),uiaConversationFingerprint:structuredClone(current.uiaConversationFingerprint)};
        this.current=null;this.frame=null;this.textResume=null;this.sharedDraftResume=null;
      }
      return{performed:true,attempted:true};
    }catch(error){
      const noInput=!attempted||!accepted&&error?.attempted===false&&error?.readOnly===true&&error?.inputSent===false;
      if(!noInput){this.draftHold={account:job.account,target:job.target};if(action==='submit')this.textSubmitAttempted=job.id;this.current=null;this.frame=null;}
      if(noInput)return{performed:false,attempted:false,reason:codeFor(error)};
      throw fault(codeFor(error),{attempted:true,inputTransport:backgroundTextTransport});
    }
  }
  typeGrapheme(job,guard,local={}) { return this.sendAction(this.current?.draftPolicy==='unchecked'&&(this.config.layoutMode==='uia-v1'||this.current.textEntryMode!=='humanized')?'paste':'type',job,{...guard,canInput:local.canInput}); }
  pasteText(job,guard,local={}) { return this.sendAction('paste',job,{...guard,canInput:local.canInput}); }
  canResumeImage(job){
    if(!object(job)||!hash(job.id))return false;
    const saved=this.current??this.textResume;
    return !this.closed&&this.imageSubmitAttempted!==job?.id&&saved?.jobId===job?.id&&saved.imageApplied===job?.id&&
      saved.account===job.account&&saved.target===job.target&&hash(job.image?.sha256)&&saved.imageSha256===job.image.sha256&&
      object(saved.binding)&&(this.config.layoutMode==='uia-v1'?validUiaImageProof(saved.uiaImageProof,job.image)&&validConversationFingerprint(saved.uiaConversationFingerprint):hash(saved.header)&&hash(saved.editor));
  }
  acceptUiaImageFrame(frame,saved,{source=false}={}){
    this.active();this.assertTransaction(frame);const roles=source?['header','editor']:['header','editor','send'],lease=this.preparationLease();
    if(this.config.layoutMode!=='uia-v1'||this.navigationPolicy!=='uia-controls-v1'||this.controlVerificationPolicy!=='input-boundaries-v1'||!validConversationFingerprint(saved.uiaConversationFingerprint)||!saved.shared||saved.draftPolicy!=='unchecked'||!lease||lease.owner!==this.client||lease.parked||
      frame.observationKind!=='uia-metadata-v1'||frame.pixelsRead!==false||frame.uiaControlFrame!==true||frame.navigationOnly===true||frame.popup||frame.pixelFormat!==undefined||frame.regions.length!==roles.length||
      !roles.every((role,index)=>frame.regions[index].role===role&&hash(frame.regions[index].controlSha256)&&frame.regions[index].rgbaSha256===undefined&&sameRect(frame.regions[index].rect,this.config.layout[role]))||
      frame.epoch!==saved.epoch||frame.revision!==saved.revision||!['hwnd','pid','threadId','processCreatedFileTimeUtc','dpi'].every(key=>frame.binding[key]===saved.binding?.[key])||!['clientRect','captureRect'].every(key=>sameRect(frame.binding[key],saved.binding?.[key])))throw fault('UI_QT_CONTROLS_BINDING_CHANGED');
    return frame;
  }
  async pasteUiaImage(job,guard,current){
    let entered=false,applied=false;
    try{
      const frame=this.acceptUiaImageFrame(this.frame,current,{source:true}),lease=this.preparationLease();
      await this.verifyControlBinding(job,frame,'image-input',guard.signal);this.active();
      if(this.current!==current||this.frame!==frame||this.preparationLease()!==lease||lease.parked)throw fault('UI_QT_CONTROLS_BINDING_CHANGED');
      if(guard.signal?.aborted||guard.canInput()!==true)return{performed:false,attempted:false,reason:'UI_TARGET_NOT_ALLOWED'};
      const ordinaryFile=job.mode==='file'&&job.image.format==='file';
      entered=true;const result=await this.client.request(ordinaryFile?'pasteUiaFile':'pasteUiaImage',{allowClipboardReplacement:this.allowClipboardReplacement,...(ordinaryFile?{deliveryId:job.id,titleSha256:current.privateChatProof?.titleSha256}:{}),token:frame.token,epoch:frame.epoch,revision:frame.revision,idleMs:this.config.idleMs,headerRect:this.config.layout.header,editorRect:this.config.layout.editor,sendRect:this.config.layout.send,imagePath:job.image.path,imageSha256:job.image.sha256});
      if(result?.performed!==true||result.attempted!==true||result.pasteApplied!==true||!clipboardSettled(result,this.allowClipboardReplacement)||result.revision!==current.revision)throw fault('UI_QT_IMAGE_PASTE_UNCONFIRMED');
      applied=true;
      if(ordinaryFile&&(result.originalFilePasted!==true||result.imageConsumption?.format!==15||result.imageConsumption?.consumerProcessMatched!==true))throw fault('UI_QT_FILE_PASTE_UNCONFIRMED');
      if(ordinaryFile&&result.fileDialogProof){
        const proof=result.fileDialogProof;
        if(!object(proof)||Object.keys(proof).length!==2||!/^[a-f0-9]{32}$/.test(proof.id)||proof.sha256!==job.image.sha256)throw fault('UI_QT_FILE_DIALOG_PROOF_INVALID');
        this.current={...current,imageApplied:job.id,imageSha256:job.image.sha256,fileDialogProof:structuredClone(proof),editorToken:crypto.randomUUID(),verifiedAt:this.now()};this.frame=null;
        return {performed:true,attempted:true,imageApplied:true,...clipboardOutcome(result)};
      }
      if(!validUiaImageProof(result.imagePasteProof,job.image)||job.image.format==='gif'&&(result.imageFormat!=='gif'||result.originalFilePasted!==true))throw fault('UI_QT_IMAGE_PASTE_UNCONFIRMED');
      const after=this.acceptUiaImageFrame(result.postPasteFrame,current);this.frame=after;
      this.current={...current,imageApplied:job.id,imageSha256:job.image.sha256,...(job.image.format==='gif'?{imageFormat:'gif'}:{}),uiaImageProof:structuredClone(result.imagePasteProof),uiaImageFrame:after,binding:structuredClone(after.binding),editorToken:crypto.randomUUID(),verifiedAt:this.now()};
      return{performed:true,attempted:true,imageApplied:true,...clipboardOutcome(result),readbackPerformed:false};
    }catch(error){
      if(!applied&&error?.controlsCleanupFailed)throw error;
      if(!applied&&(error.clipboardRestored!==false||clipboardSettled(error,this.allowClipboardReplacement))&&(!entered||error.attempted===false))return{performed:false,attempted:false,reason:codeFor(error)};
      this.draftHold={account:job.account,target:job.target};this.current=null;this.frame=null;error.attempted=true;throw error;
    }
  }
  async submitUiaImage(job,guard,current){
    try{
      if(job.mode==='file'&&current.fileDialogProof){
        if(guard.signal?.aborted||!guard.canSubmit())return {performed:false,attempted:false};
        this.imageSubmitAttempted=job.id;
        const result=await this.client.request('submitUiaFileDialog',{proofId:current.fileDialogProof.id,sha256:job.image.sha256});
        if(result.performed!==true||result.attempted!==true||result.inputQueued!==true||result.revision!==current.revision)throw fault('UI_QT_FILE_SUBMIT_UNCONFIRMED');
        this.current=null;this.frame=null;return {performed:true,attempted:true};
      }
      if(!validUiaImageProof(current.uiaImageProof,job.image)||this.frame!==current.uiaImageFrame)throw fault('UI_QT_IMAGE_APPLICATION_UNKNOWN');
      const frame=this.acceptUiaImageFrame(this.frame,current),lease=this.preparationLease(),proof=structuredClone(current.uiaImageProof);
      await this.verifyControlBinding(job,frame,'image-submit',guard.signal);this.active();
      if(this.current!==current||this.frame!==frame||this.preparationLease()!==lease||!isDeepStrictEqual(current.uiaImageProof,proof))throw fault('UI_QT_CONTROLS_BINDING_CHANGED');
      if(guard.signal?.aborted||guard.canSubmit()!==true)return{performed:false,attempted:false,reason:'UI_TARGET_NOT_ALLOWED'};
      this.imageSubmitAttempted=job.id;
      const result=await this.client.request('submitUiaImage',{token:frame.token,epoch:frame.epoch,revision:frame.revision,idleMs:this.config.idleMs,imagePasteProofId:proof.id,imageSha256:proof.imageSha256});
      const queued=result?.inputQueued===true&&result.submitted===false&&result.submissionConfirmed===false&&validUiaPointerDelivery(result.pointerDelivery,'image-submit');
      const legacy=result?.submitted===true&&result.pointerDelivery===undefined&&result.inputQueued===undefined;
      if(result?.performed!==true||result.attempted!==true||!queued&&!legacy||result.revision!==current.revision)throw fault('UI_QT_IMAGE_SUBMIT_UNCONFIRMED');
      this.current=null;this.frame=null;return{performed:true,attempted:true};
    }finally{await this.releaseTextFocus();}
  }
  async resumeImage(job,{signal,canInput}={}){
    this.checkJob(job);if(this.busy)throw fault('UI_QT_BUSY');
    if(!this.canResumeImage(job))return{ready:false,reason:'UI_QT_IMAGE_RESUME_UNAVAILABLE'};
    if(typeof canInput!=='function'||canInput()!==true)return{ready:false,reason:'UI_TARGET_NOT_ALLOWED'};
    const saved=this.current??this.textResume,owner=this.client,ownedImageFrame=this.current===saved&&this.textFocusLease&&this.frame===saved.uiaImageFrame?this.frame:null;let resumed=false;
    this.busy=true;this.operationSignal=signal;this.#completedTextNavigation=null;
    const matches=binding=>object(binding)&&['hwnd','pid','threadId','processCreatedFileTimeUtc','dpi'].every(key=>binding[key]===saved.binding[key])&&
      ['clientRect','captureRect'].every(key=>sameRect(binding[key],saved.binding[key]));
    try{
      this.active();if(this.textFocusRelease)await this.textFocusRelease;
      const inspection=await owner.request('inspectLayout');this.active();
      if(inspection?.readOnly!==true||inspection.inputSent!==false||inspection.focusChanged!==false||inspection.clipboardAccessed!==false||
        inspection.executableVersion!==this.config.executableVersion||inspection.executableSha256!==this.config.executableSha256||!matches(inspection.binding))throw fault('UI_QT_IMAGE_RESUME_BINDING_CHANGED');
      const account=await this.freshAccount({frame:{binding:inspection.binding},park:false});this.active();
      validateAccountEvidence(account.evidence,inspection.binding,this.now());
      if(canInput()!==true)return{ready:false,reason:'UI_TARGET_NOT_ALLOWED'};
      if(saved.shared&&!this.textFocusLease){
        const preflight=await owner.request('inspectFocusHandoff',{idleMs:this.config.idleMs,width:this.config.layout.width,height:this.config.layout.height,dpi:this.config.layout.dpi});this.active();
        if(!object(preflight)||typeof preflight.ready!=='boolean'||preflight.inputSent!==false||preflight.clipboardAccessed!==false||preflight.focusChanged!==false||
          preflight.ready&&preflight.reason!==null||!preflight.ready&&!/^(?:QT_|DRAFT_)[A-Z0-9_]{1,80}$/.test(preflight.reason??''))throw fault('UI_QT_FOCUS_PREFLIGHT_INVALID');
        if(!preflight.ready&&preflight.reason!=='QT_FOCUS_RETURN_WINDOW_REQUIRED')return{ready:false,reason:preflight.reason};
        if(preflight.ready){
          if(canInput()!==true)return{ready:false,reason:'UI_TARGET_NOT_ALLOWED'};
          const acquired=await owner.request('beginFocusHandoff',{idleMs:this.config.idleMs,width:this.config.layout.width,height:this.config.layout.height,dpi:this.config.layout.dpi,includesContactNavigation:false,...this.focusActivation()});
          if(acquired?.activated!==true||!validFocusHandoff(acquired.focusHandoff))throw fault('UI_QT_FOCUS_LEASE_INVALID');
          this.textFocusLease={owner,handoff:structuredClone(acquired.focusHandoff),uiaMode:this.config.layoutMode==='uia-v1'};this.textFocusRelease=null;this.foregroundIntervals=[];this.foregroundIntervalsInvalid=false;
        }
      }
      this.current=null;this.frame=null;this.transaction=null;this.surface='main';
      if(this.config.layoutMode==='uia-v1'){
        let frame=ownedImageFrame,proof=saved.uiaImageProof;
        if(!frame){
          const result=await owner.request('resumeUiaImage',{epoch:saved.epoch,revision:saved.revision,idleMs:this.config.idleMs,imagePasteProofId:proof.id,imageSha256:proof.imageSha256});this.active();
          if(result?.resumed!==true||result.readOnly!==true||result.inputSent!==false||result.focusChanged!==false||result.clipboardAccessed!==false||!validUiaImageProof(result.imagePasteProof,job.image)||!isDeepStrictEqual(result.imagePasteProof,proof))throw fault('UI_QT_IMAGE_RESUME_BINDING_CHANGED');
          frame=result.frame;
        }
        this.acceptUiaImageFrame(frame,saved);this.frame=frame;
        this.transaction={epoch:frame.epoch,revision:frame.revision,pid:frame.binding.pid,created:frame.binding.processCreatedFileTimeUtc};
        const verified=await this.verifyControlBinding(job,frame,'image-resume',signal);
        if(!validConversationFingerprint(verified?.conversationFingerprint)||!isDeepStrictEqual(verified.conversationFingerprint,saved.uiaConversationFingerprint))throw fault('UI_QT_IMAGE_DRAFT_CHANGED');
        validateAccountEvidence(account.evidence,frame.binding,this.now());this.active();
        if(canInput()!==true)return{ready:false,reason:'UI_TARGET_NOT_ALLOWED'};
        this.current={...saved,uiaImageFrame:frame,uiaImageProof:structuredClone(proof),binding:structuredClone(frame.binding),editorToken:crypto.randomUUID(),verifiedAt:this.now()};this.textResume=null;resumed=true;return{ready:true,imageResume:true};
      }
      const frame=await this.capture(['header',saved.imageFormat==='gif'?'send':'editor']);
      if(!matches(frame.binding)||frame.epoch!==saved.epoch)throw fault('UI_QT_IMAGE_RESUME_BINDING_CHANGED');
      // GIF pixels change without user input. Its same-process paste proof can
      // survive a queue pause, but not intervening human input or a new epoch.
      if(saved.imageFormat==='gif'&&frame.revision!==saved.revision)throw fault('UI_QT_IMAGE_DRAFT_CHANGED');
      if(frame.popup||frame.regions.length!==2||frame.regions[0].rgbaSha256!==saved.header||frame.regions[1].rgbaSha256!==saved.editor)throw fault('UI_QT_IMAGE_DRAFT_CHANGED');
      if(frame.idleMs<this.config.idleMs)throw fault('UI_USER_ACTIVE');
      validateAccountEvidence(account.evidence,frame.binding,this.now());this.active();
      if(canInput()!==true)return{ready:false,reason:'UI_TARGET_NOT_ALLOWED'};
      this.transaction={epoch:frame.epoch,revision:frame.revision,pid:frame.binding.pid,created:frame.binding.processCreatedFileTimeUtc};
      this.current={...saved,epoch:frame.epoch,revision:frame.revision,binding:structuredClone(frame.binding),editorToken:crypto.randomUUID(),verifiedAt:this.now()};
      this.textResume=null;resumed=true;return{ready:true,imageResume:true};
    }catch(error){
      if(['UI_QT_IMAGE_RESUME_BINDING_CHANGED','UI_QT_IMAGE_DRAFT_CHANGED','UI_USER_ACTIVE'].includes(error.code))return{ready:false,reason:error.code};
      throw error;
    }finally{
      try{if(!resumed){await this.releaseTextFocus();this.current=null;this.frame=null;this.transaction=null;if(!this.closed&&this.client===owner)this.textResume=saved;}}
      finally{this.operationSignal=null;this.busy=false;}
    }
  }
  async pasteImage(job,guard,local={}){
    guard={...guard,...(typeof local.canInput==='function'?{canInput:local.canInput}:{})};
    this.checkJob(job);const current=this.current;
    if(!current||current.jobId!==job.id||current.account!==job.account||current.target!==job.target||guard?.editorToken!==current.editorToken||guard.activityRevision!==current.revision||typeof guard.canInput!=='function'||guard.canInput()!==true)return {performed:false,attempted:false,reason:'UI_QT_INPUT_AUTHORIZATION_REQUIRED'};
    if(current.imageApplied||!object(job.image)||!hash(job.image.sha256)||!path.isAbsolute(job.image.path??''))return {performed:false,attempted:false,reason:'UI_QT_IMAGE_INVALID'};
    if(this.config.layoutMode==='uia-v1')return this.pasteUiaImage(job,guard,current);
    let entered=false,pasteApplied=false;
    try{
      const frame=await this.capture(['header','editor']);
      if(frame.regions[0].rgbaSha256!==current.header)return {performed:false,attempted:false,reason:'UI_QT_HEADER_CHANGED'};
      await this.verifyControlBinding(job,frame,'image-input',guard.signal);
      this.active();if(guard.signal?.aborted||guard.canInput()!==true)return {performed:false,attempted:false,reason:'UI_TARGET_NOT_ALLOWED'};
      entered=true;
      const result=await this.client.request('pasteImage',{allowClipboardReplacement:this.allowClipboardReplacement,token:frame.token,epoch:frame.epoch,revision:frame.revision,idleMs:this.config.idleMs,headerRect:this.config.layout.header,editorRect:this.config.layout.editor,foregroundOnly:!this.preparationLease(),imagePath:job.image.path,imageSha256:job.image.sha256});
      if(result.performed!==true||result.attempted!==true||result.pasteApplied!==true||!clipboardSettled(result,this.allowClipboardReplacement)||result.revision!==current.revision)throw fault('UI_QT_IMAGE_PASTE_UNCONFIRMED');
      pasteApplied=true;
      const gif=job.image.format==='gif';
      if(gif&&(result.imageFormat!=='gif'||result.originalFilePasted!==true))throw fault('UI_QT_IMAGE_PASTE_UNCONFIRMED');
      // The animation is intentionally excluded from stable pixel anchors.
      // Native input still binds the account/window, header and activity epoch.
      this.frame=null;const after=await this.capture(['header',gif?'send':'editor']);
      if(after.regions[0].rgbaSha256!==current.header)throw fault('UI_QT_HEADER_CHANGED');
      this.current={...current,imageApplied:job.id,imageSha256:job.image.sha256,...(gif?{imageFormat:'gif'}:{}),binding:structuredClone(after.binding),header:after.regions[0].rgbaSha256,editorToken:crypto.randomUUID(),verifiedAt:this.now(),editor:after.regions[1].rgbaSha256};
      return {performed:true,attempted:true,imageApplied:true,...clipboardOutcome(result),readbackPerformed:false};
    }catch(error){
      if(!pasteApplied&&error?.controlsCleanupFailed)throw error;
      if(!pasteApplied&&(error.clipboardRestored!==false||clipboardSettled(error,this.allowClipboardReplacement))&&(!entered||error.attempted===false))return {performed:false,attempted:false,reason:codeFor(error)};
      this.draftHold={account:job.account,target:job.target};this.current=null;this.frame=null;if(pasteApplied)error.attempted=true;throw error;
    }
  }
  async submitImage(job,guard,local={}){
    guard={...guard,...(typeof local.canSubmit==='function'?{canSubmit:local.canSubmit}:{})};
    this.checkJob(job);const current=this.current;
    if(!this.allowSubmit)return {performed:false,attempted:false,reason:'UI_SUBMIT_DISABLED'};
    if(this.imageSubmitAttempted===job.id)return {performed:false,attempted:false,reason:'UI_QT_IMAGE_SUBMIT_UNCONFIRMED'};
    if(!current||current.imageApplied!==job.id||current.imageSha256!==job.image?.sha256||current.editorToken!==guard?.editorToken||current.revision!==guard.activityRevision||typeof guard.canSubmit!=='function'||guard.canSubmit()!==true)return {performed:false,attempted:false,reason:'UI_QT_IMAGE_APPLICATION_UNKNOWN'};
    if(this.config.layoutMode==='uia-v1')return this.submitUiaImage(job,guard,current);
    try{
      const frame=await this.capture(['header',current.imageFormat==='gif'?'send':'editor']);if(frame.regions[0].rgbaSha256!==current.header)return {performed:false,attempted:false,reason:'UI_QT_HEADER_CHANGED'};
      await this.verifyControlBinding(job,frame,'image-submit',guard.signal);
      this.active();if(guard.signal?.aborted||guard.canSubmit()!==true)return {performed:false,attempted:false,reason:'UI_TARGET_NOT_ALLOWED'};
      // Images are inline attachments on this client; click its current send
      // control. A changed focus never grants a second keyboard submission.
      this.imageSubmitAttempted=job.id;
      const result=await this.client.request('click',{token:frame.token,epoch:frame.epoch,revision:frame.revision,idleMs:this.config.idleMs,rect:this.config.layout.send});
      if(result.performed!==true||result.attempted!==true)throw fault('UI_QT_IMAGE_SUBMIT_UNCONFIRMED');
      this.current=null;this.frame=null;return {performed:true,attempted:true};
    }finally{await this.releaseTextFocus();}
  }
  get textSubmitPreparationPolicy(){return 'receipt-barrier-v1';}
  async submit(job,guard,local = {}) { try{return await this.sendAction('submit',job,{...guard,...(typeof local.canSubmit === 'function' ? {canSubmit:local.canSubmit} : {})},{beforeSubmit:local.beforeSubmit});}finally{await this.releaseTextFocus();} }
  /** Admission check only: keep a queued reply waiting while the user is active,
   * before the voice outbox writes an irreversible recording intent. */
  async prepareVoiceHandoff(job,{signal}={}){
    this.checkJob(job);if(this.busy)return {ready:false,reason:'UI_QT_BUSY'};
    if(signal?.aborted)return {ready:false,reason:'UI_QT_CANCELLED'};
    if(!validVoiceLayout(this.config.voice,this.config.layout,this.config.layoutMode==='uia-v1'))return {ready:false,reason:'UI_QT_VOICE_CALIBRATION_REQUIRED'};
    this.busy=true;
    try{
      const result=await this.client.request('inspectFocusHandoff',{idleMs:this.config.idleMs,width:this.config.layout.width,height:this.config.layout.height,dpi:this.config.layout.dpi});
      if(!object(result)||typeof result.ready!=='boolean'||result.inputSent!==false||result.clipboardAccessed!==false||result.focusChanged!==false||
          result.ready&&result.reason!==null||!result.ready&&!/^(?:QT_|DRAFT_)[A-Z0-9_]{1,80}$/.test(result.reason??''))throw fault('UI_QT_FOCUS_PREFLIGHT_INVALID');
      if(signal?.aborted)return {ready:false,reason:'UI_QT_CANCELLED'};
      return result.ready?{ready:true}:{ready:false,reason:result.reason};
    }finally{this.busy=false;}
  }
  async prepareVoiceSession(job, {signal,interactionPlan} = {}) {
    this.checkJob(job);
    const voice=this.config.voice;
    if (!validVoiceLayout(voice,this.config.layout,this.config.layoutMode==='uia-v1')) throw fault('UI_QT_VOICE_CALIBRATION_REQUIRED');
    const shared=interactionPlan?.executionMode==='focus-handoff';let leaseClient,transferred,releaseFocus,accountProof,finalizing=false,transferOwner,transferOwnerReleased=false,transferValidation;
    const voicePreparation=shared&&observedLayout(this.config)?{controller:new AbortController()}:null;
    const abortProbe=()=>voicePreparation?.controller.abort();
    if(voicePreparation){
      signal?.addEventListener('abort',abortProbe,{once:true});if(signal?.aborted)abortProbe();
      // Start one read-only account scan after search Enter, alongside page
      // presentation. Keep its original timestamp and the existing 500ms limit.
      voicePreparation.start=frame=>{
        if(!voicePreparation.pending){const binding=structuredClone(frame.binding);
          voicePreparation.pending=Promise.resolve().then(()=>this.probeAccount({root:this.root,binding,executable:this.config.executable,expectedAccountRef:this.config.accountRef,signal:voicePreparation.controller.signal})).then(proof=>({proof}),error=>({error}));
        }
      };
    }
    try{
    if(this.busy||signal?.aborted)throw fault(signal?.aborted?'UI_QT_CANCELLED':'UI_QT_BUSY');
    const targetLookup=shared&&observedLayout(this.config)?await this.lookupTarget(job,{signal}):(await Promise.all([this.warmRecognition(signal),this.lookupTarget(job,{signal})]))[1];
    if(shared){
      if(this.busy||signal?.aborted)throw fault(signal?.aborted?'UI_QT_CANCELLED':'UI_QT_BUSY');
      leaseClient=this.client;
      await this.warmUiaLocators({owner:leaseClient,signal});
      const acquired=await leaseClient.request('beginFocusHandoff',{idleMs:this.config.idleMs,width:this.config.layout.width,height:this.config.layout.height,dpi:this.config.layout.dpi,includesContactNavigation:observedLayout(this.config),...this.focusActivation()});
      if(acquired?.activated!==true||!validFocusHandoff(acquired.focusHandoff))throw fault('UI_QT_FOCUS_LEASE_INVALID');
      this.voiceFocusLease={owner:leaseClient,handoff:structuredClone(acquired.focusHandoff),uiaMode:this.config.layoutMode==='uia-v1',uiaInitialHeaderPending:true};this.foregroundIntervals=[];this.foregroundIntervalsInvalid=false;
      if(voicePreparation)voicePreparation.lease=this.voiceFocusLease;
    }
    const preparation=await this.prepare(job,{signal,textEntryMode:interactionPlan?.textEntryMode??'humanized',[preparedTargetLookup]:targetLookup,...(voicePreparation?{[sharedVoicePreparation]:voicePreparation}:{})});
    if(preparation?.ready!==true)throw fault(preparationWaits.has(preparation?.reason)?preparation.reason:'UI_QT_PREPARATION_REQUIRED',{attempted:false,waitable:true});
    this.busy=true;this.operationSignal=signal;finalizing=true;
    if(signal?.aborted){await this.client.close();throw fault('UI_QT_CANCELLED');}
    if (!this.current || this.current.draft !== '') throw fault('UI_QT_EMPTY_DRAFT_REQUIRED');
    const emptyDraft=this.current,unchecked=shared&&this.current.draftPolicy==='unchecked';
    const uiaVoice=this.config.layoutMode==='uia-v1'&&this.navigationPolicy==='uia-controls-v1'&&this.controlVerificationPolicy==='input-boundaries-v1';
    if(uiaVoice&&(!unchecked||!object(voice.recordingUi.uia)||!validConversationFingerprint(emptyDraft.uiaConversationFingerprint)))throw fault('UI_QT_CONTROLS_UNVERIFIED');
    const sameEmptyDraft=async frame=>{
      if(this.current!==emptyDraft||emptyDraft.draft!==''||emptyDraft.account!==job.account||emptyDraft.target!==job.target||frame.epoch!==emptyDraft.epoch||frame.revision!==emptyDraft.revision)return false;
      if(uiaVoice)return frame.observationKind==='uia-metadata-v1'&&frame.pixelsRead===false&&this.regionDigest(frame,0)===emptyDraft.header;
      if(frame.regions[0].rgbaSha256!==emptyDraft.header)return false;
      if(unchecked)return true;
      const before=emptyDraft.editor,after=frame.regions[1].rgbaSha256,known=emptyDraft.verifiedEmptyHashes;
      if(after===before||qtEmptyEditorPhaseMatches(before,after,known))return true;
      const proof=emptyDraft.emptyDraftPhaseProof,baselineVerified=known?.includes(before)||emptyDraft.verifiedEmptyPhase?.proofId===proof?.id&&emptyDraft.verifiedEmptyPhase?.actualRgbaSha256===before;
      if(!proof||!baselineVerified)return false;
      if(known.includes(after))return true;
      await this.inspectEmptyDraftPhase(frame,proof);return this.current===emptyDraft&&emptyDraft.draft==='';
    };
    let frame=unchecked?this.frame:await this.capture(['header','editor']);
    if(signal?.aborted){await this.client.close();throw fault('UI_QT_CANCELLED');}
    if (!await sameEmptyDraft(frame)) throw fault('UI_QT_DRAFT_CHANGED');
    if(shared){
      // The unchecked voice path retains its ready main frame. Native transfer
      // checks activity again; the legacy verified route still parks and
      // rechecks its empty-draft frame around the account probe.
      const probe=async()=>{
        const proof=await this.probeAccount({root:this.root,binding:frame.binding,executable:this.config.executable,expectedAccountRef:this.config.accountRef,signal});
        if(proof?.accountRef!==this.config.accountRef||proof.evidence?.processOpenedExpectedDatabase!==true||proof.evidence?.processId!==frame.binding.pid||proof.evidence?.processCreatedFileTimeUtc!==frame.binding.processCreatedFileTimeUtc)throw fault('UI_QT_ACCOUNT_UNVERIFIED');
        return proof;
      };
      accountProof=voicePreparation?.proof??(unchecked?await probe():await this.withPreparationFocusParked(probe));
      // UIA scans can outlive the overlapping account proof. They retain the
      // initial validation above, then obtain a new proof after final release.
      if(voicePreparation&&!this.verifyControls)validateAccountEvidence(accountProof.evidence,frame.binding,this.now());
      if(!unchecked)frame=await this.capture(['header','editor']);
      if(!await sameEmptyDraft(frame))throw fault('UI_QT_DRAFT_CHANGED');
    }
    await this.verifyControlBinding(job,frame,'voice-start',signal);
    const at=this.now();
    const calibrationHash=crypto.createHash('sha256').update(JSON.stringify(this.config.layout)).digest('hex');
    const session={version:2,id:crypto.randomBytes(16).toString('hex'),calibrationHash,accountScopeHash:this.config.accountRef,target:job.target,
      executable:this.config.executable,hwnd:frame.binding.hwnd,focusHwnd:frame.binding.focusHwnd,processCreatedFileTimeUtc:frame.binding.processCreatedFileTimeUtc,
      pid:frame.binding.pid,dpi:frame.binding.dpi,lastInputTick:frame.binding.lastInputTick,clientRect:frame.binding.clientRect,captureRect:frame.binding.captureRect,
      editorRect:this.config.layout.editor,issuedAtMs:at,expiresAtMs:at+30000,emptyDraftConfirmed:!unchecked,...(unchecked?{draftPolicy:'unchecked'}:{}),recordStartRect:voice.recordStartRect,...(voice.mouseParkRect!==undefined?{mouseParkRect:voice.mouseParkRect}:{}),
      recordingUi:{...voice.recordingUi,focusHwnd:voice.recordingUi.focusHwnd === 'same' ? frame.binding.focusHwnd : voice.recordingUi.focusHwnd,...(uiaVoice?{uia:{...voice.recordingUi.uia,conversationFingerprint:structuredClone(emptyDraft.uiaConversationFingerprint)}}:{})},
      targetProof:{kind:job.target.endsWith('@chatroom')?'verified-qt-group-chat-v1':'verified-qt-private-chat-v1',target:job.target,accountRef:this.config.accountRef,...(job.target.endsWith('@chatroom')?{querySha256:emptyDraft.privateChatProof.querySha256}:{}),...(uiaVoice?{conversationFingerprint:structuredClone(emptyDraft.uiaConversationFingerprint)}:{titleAnchor:{rect:this.config.layout.header,rgbaSha256:frame.regions[0].rgbaSha256}})}};
    if (typeof this.client.release !== 'function') throw fault('UI_QT_INPUT_RELEASE_REQUIRED');
    if(shared){
      transferOwner=this.client;const originalHandoff=structuredClone(this.voiceFocusLease?.handoff);
      transferred=await this.client.request('transferFocusHandoff');
      transferValidation=transferredFocusValidation(transferred,frame,originalHandoff,this.now());
      if(transferred?.transferred===true)this.voiceFocusLease=null;
      if(transferValidation.cleanupAvailable){
        const cleanup=structuredClone(transferred.cleanup);let cleanupRun;
        // Until release is acknowledged, the original helper still owns the
        // native mutex. Reuse it for rollback instead of opening a competitor.
        releaseFocus=()=>cleanupRun??=(async()=>{if(!transferOwnerReleased)return transferOwner.request('restoreTransferredFocus',{cleanup});const helper=this.clientFactory();try{return await helper.request('restoreTransferredFocus',{cleanup});}finally{await helper.close();}})();
      }
      if(!transferValidation.valid)throw fault('UI_QT_FOCUS_LEASE_INVALID',{focusTransferValidation:transferValidation});
      // Returning Qt's pointer is marked input and advances Windows' input
      // tick. Bind the unmonitored handoff gap to the guarded final tick.
      session.lastInputTick=transferred.cleanup.lastInputTick;
    }
    const stopped=await this.client.release();this.current=null;this.frame=null;this.transaction=null;
    if (stopped?.processStopped !== true) throw fault('UI_QT_STOP_UNCONFIRMED');
    transferOwnerReleased=true;
    this.client=this.clientFactory();
    // The old process has exited (and released the native mutex) before the
    // recording helper can start. A last-input tick binds the unmonitored gap.
    if(this.verifyControls||!accountProof)accountProof=await this.probeAccount({root:this.root,binding:frame.binding,executable:this.config.executable,expectedAccountRef:this.config.accountRef,signal});
    if(signal?.aborted)throw fault('UI_QT_CANCELLED');
    if(accountProof?.accountRef!==this.config.accountRef||accountProof.evidence?.processId!==frame.binding.pid||accountProof.evidence?.processCreatedFileTimeUtc!==frame.binding.processCreatedFileTimeUtc)throw fault('UI_QT_ACCOUNT_UNVERIFIED');
    if(this.verifyControls){
      if(accountProof.accountScopeHash!==this.config.accountRef)throw fault('UI_QT_ACCOUNT_UNVERIFIED');
      validateAccountEvidence(accountProof.evidence,frame.binding,this.now());
    }
    const foregroundIntervals=shared?this.completedForegroundIntervals():undefined;
    return {session,accountProof,...(shared?{focusHandoff:structuredClone(transferred.focusHandoff),releaseFocus,...(foregroundIntervals?{foregroundIntervals}:{})}:{})};
    }catch(error){
      abortProbe();
      if(releaseFocus){try{const returned=await releaseFocus();if(returned?.restored!==true&&returned?.skipped!==true)throw fault('UI_QT_FOCUS_RETURN_UNCONFIRMED');if(focusRestoreOutcomeDiagnostic(returned?.focusRestoreOutcome))error.focusRestoreOutcome=focusRestoreOutcomeDiagnostic(returned.focusRestoreOutcome);}
        catch(cleanupError){throw fault('UI_QT_FOCUS_RETURN_UNCONFIRMED',{...focusReturnDiagnostics(cleanupError),...(transferValidation?{focusTransferValidation:transferValidation}:{})});}}
      else if(transferred?.transferred===true)throw fault('UI_QT_FOCUS_RETURN_UNCONFIRMED',{focusTransferValidation:transferValidation});
      else if(leaseClient){try{if(!leaseClient.closed){const returned=await leaseClient.request('releaseFocusHandoff');if(returned?.restored===true&&returned.skipped===false)markNavigationRefusal(error,'restored');}}catch{try{await leaseClient.close();}catch{throw fault('UI_QT_FOCUS_RETURN_UNCONFIRMED');}}}
      throw error;
    }finally{abortProbe();await voicePreparation?.pending;signal?.removeEventListener('abort',abortProbe);if(this.voiceFocusLease?.owner===leaseClient)this.voiceFocusLease=null;if(finalizing){this.operationSignal=null;this.busy=false;}}
  }
  receipt(job,options) { return this.receiptProvider ? this.receiptProvider(job,options) : Promise.resolve({confirmed:false}); }
  async close() { try{await this.releaseTextFocus();}finally{this.#completedTextNavigation=null;this.closed = true;this.current = null;await this.client.close();} }
}

export function createQtVisualDriver({ root = path.resolve(import.meta.dirname,'..'), configFile = path.join(root,'state/ui-runtime/qt-visual.json'), config, client, enableInput = false, allowSubmit = false, requiredIdleMs, ...options } = {}) {
  if (!config) { noLinks(configFile); const stat = fs.statSync(configFile,{throwIfNoEntry:false}); if (!stat?.isFile() || stat.size > 131072) throw fault('UI_QT_CALIBRATION_REQUIRED'); try { config = JSON.parse(fs.readFileSync(configFile,'utf8')); } catch { throw fault('UI_QT_CONFIG_INVALID'); } }
  if(requiredIdleMs!==undefined&&(!Number.isSafeInteger(requiredIdleMs)||requiredIdleMs<0||requiredIdleMs>300000))throw fault('UI_QT_CONFIG_INVALID');
  const base=validateQtConfig(config);
  const validated = requiredIdleMs===undefined?base:validateQtConfig({...base,idleMs:Math.max(base.idleMs,requiredIdleMs)});
  const clientFactory=()=>new QtActionsClient({root,config:validated,enableInput});
  return new QtVisualDriver({ root,config:validated,client:client ?? clientFactory(),clientFactory,allowSubmit,...options });
}
