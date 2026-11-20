import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { validateQtConfig, exactProfileAlias, exactPrivateSearchResult, observedProfileAlias, observedPrivateSearchResult, toObservedPopupCalibration, QtVisualDriver, createQtVisualDriver, qtEmptyEditorHashes,qtEmptyEditorPhaseMatches } from './qt-visual-driver.mjs';
import { UiOneBotBackend, uiOneBotId, createReceiptUiDriver, createImageUiDriver } from './ui-onebot.mjs';
import { createSelectionGuardedDriver } from './target-selection.mjs';
import { readForegroundTimings } from './foreground-timing.mjs';
import { UiTextOutbox } from './ui-text-outbox.mjs';
import { UiReplyOutbox,inspectPreparationControl } from './ui-reply-outbox.mjs';
import { UiImageOutbox } from './ui-image-outbox.mjs';
import {confirmQuoteDraftSent,clearQuoteDraftMarkers} from './qt-visual-driver.mjs';

test('rich quote in OCR sender uses an available semantic list and passes the exact type and sequence',async t=>{
  const f=fixture(t,withObservedPopups),token='d'.repeat(32);
  const pattern={rows:[{kind:'text',text:'one'},{kind:'voice'},{kind:'image'},{kind:'image'}],index:3,ocrAnchor:0};
  const quote={id:'history',serverId:'456',sender:f.job.target,text:'[图片]',kind:'image',locator:pattern};
  assert.equal(f.driver.nativeRichQuoteAvailable,true);
  f.driver.client.request=async(action,request)=>{
    assert.equal(action,'attachMessageQuote');assert.equal(request.quoteKind,'image');
    assert.deepEqual(request.quoteLocator,pattern);assert.equal(request.fromSelf,false);
    return {attached:true,quoteToken:token,editorRect:f.driver.region('editor')};
  };
  const result=await f.driver.attachMessageQuote({...f.job,quote},{token:'frame',epoch:1,revision:2});
  assert.equal(result.mode,'uia');assert.equal(result.quoteToken,token);
});

test('a quote stays attached to one foreground delivery and requires an exact receipt to clear its draft',async t=>{
  const f=fixture(t,withObservedPopups),job={...f.job,quote:{id:'history',serverId:'1234',sender:f.job.target,text:'历史消息'}},token='e'.repeat(32);
  const file=f.driver.quoteMarker(job);
  f.driver.attachMessageQuote=async quoted=>{
    assert.equal(JSON.parse(fs.readFileSync(file)).bound,false);
    assert.equal(quoted.quote.serverId,'1234');return {attached:true,quoteToken:token,editorRect:f.driver.region('editor')};
  };
  assert.equal(await f.driver.tryPrepareBackgroundText(job),false);
  assert.equal((await f.driver.prepare(job,{interactionPlan:{sendMode:'focus-handoff'},textEntryMode:'paste'})).ready,true);
  assert.equal(f.driver.current.quoteToken,token);
  const observation=await f.driver.observe(job);
  const guard={expectedDraft:'',editorToken:observation.editorToken,activityRevision:observation.activityRevision,text:job.text,canInput:()=>true};
  assert.equal((await f.driver.pasteText({...job,quote:null},guard,{canInput:()=>true})).performed,false);
  assert.equal((await f.driver.pasteText(job,guard,{canInput:()=>true})).performed,true);
  assert.equal(f.actions.filter(item=>item.action==='paste').at(-1).quoteToken,token);
  const pasted=await f.driver.observe(job);
  assert.equal((await f.driver.submit(job,{expectedDraft:job.text,editorToken:pasted.editorToken,activityRevision:pasted.activityRevision},{canSubmit:()=>true})).performed,true);
  assert.equal(f.actions.find(item=>item.action==='submitTextEnter').quoteToken,token);
  const args=[f.driver.root,f.driver.config.accountRef,job.target];
  assert.equal(confirmQuoteDraftSent(...args,'0'.repeat(64)),false);
  assert.equal(clearQuoteDraftMarkers(f.driver.root,f.driver.config.accountRef,'wxid_another'),false);
  assert.equal(confirmQuoteDraftSent(...args,job.id),true);
  assert.equal(fs.existsSync(file),false);
});

test('a definite quote source miss clears its marker while an interrupted menu remains held',async t=>{
  for(const untouched of [true,false]){
    const f=fixture(t,withObservedPopups),job={...f.job,quote:{serverId:'1234',text:'历史消息'}};
    f.driver.attachMessageQuote=async()=>{throw Object.assign(new Error('quote refused'),{code:untouched?'UI_QUOTE_TARGET_UNAVAILABLE':'QT_QUOTE_MENU_UNCONFIRMED',attempted:!untouched,quoteDraftUntouched:untouched});};
    await assert.rejects(f.driver.prepare(job,{interactionPlan:{sendMode:'focus-handoff'},textEntryMode:'paste'}));
    assert.equal(fs.existsSync(f.driver.quoteMarker(job)),!untouched);
  }
});
import { validateAccountEvidence } from './account-probe.mjs';

const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const r = (left,top,right,bottom) => ({left,top,right,bottom});
const warmUiaAcknowledgment=binding=>({version:1,warmed:true,readOnly:true,inputSent:false,focusChanged:false,clipboardAccessed:false,authorizationGranted:false,foregroundUnchanged:true,inputTickUnchanged:true,cursorUnchanged:true,binding:{...structuredClone(binding),foreground:true},roles:['header','editor','send']});
function config() { return { version:1,backend:'qt-visual',account:'wxid_self',accountRef:'a'.repeat(64),accountAlias:'my_alias',executable:path.resolve('Weixin.exe'),executableVersion:'4.1.15.56',executableSha256:'b'.repeat(64),hwnd:'100',idleMs:1000,ocrBackend:'rapidocr',layout:{width:800,height:600,dpi:96,
  header:r(310,20,600,60),search:r(80,20,260,60),firstResult:r(80,80,260,120),searchResultIdentity:r(80,60,260,140),profileOpen:r(720,20,760,60),profileAlias:r(300,100,600,150),profileClose:r(700,80,730,110),selfOpen:r(10,20,50,60),selfAlias:r(60,100,300,150),selfClose:r(330,80,350,100),editor:r(300,450,780,550),send:r(700,560,780,590),emptyEditorSha256:'c'.repeat(64)}}; }
const word = (text,area,line=0,confidence=0.99) => ({text,x:area.left+1,y:area.top+1,width:area.right-area.left-2,height:20,line,confidence});
const searchWords=area=>[word('联系人',r(area.left,area.top,area.right,area.top+20),0),word('Fixture',r(area.left,area.top+25,area.right,area.top+45),1),word('微信号：target_A',r(area.left,area.top+50,area.right,area.top+75),2)];
const popupCalibration=(kind='profile')=>({version:1,kind,className:'QtFixtureWindow',ownerRelation:'same-thread-unowned',ownerDepth:0,windowRect:kind==='search'?r(60,10,280,140):r(20,60,380,260),clientWidth:kind==='search'?220:360,clientHeight:kind==='search'?130:200,style:-2147483648,extendedStyle:128});
function withPopups(c){for(const key of ['selfSurface','profileSurface'])c[key]={width:360,height:200,alias:r(20,60,320,110),close:r(330,10,350,30),popupCalibration:popupCalibration()};c.searchPopupCalibration=popupCalibration('search');return c;}
function withObservedPopups(c){c.layoutMode='adaptive-v1';for(const key of ['selfSurface','profileSurface'])c[key]={popupCalibration:toObservedPopupCalibration(popupCalibration(),'profile')};c.searchPopupCalibration=toObservedPopupCalibration(popupCalibration('search'),'search');c.selfCloseKey='Escape';c.profileCloseKey='Escape';c.layout.profileOpen=r(400,25,500,50);for(const key of ['firstResult','searchResultIdentity','profileAlias','profileClose','selfAlias','selfClose'])delete c.layout[key];return c;}

test('OCR shared navigation stays fast while only body text uses per-grapheme input and one Enter',async t=>{
  const f=fixture(t,c=>{withObservedPopups(c);c.newlineKey='Shift+Enter';}),plan={executionMode:'foreground',sendMode:'focus-handoff',textEntryMode:'humanized'};
  assert.equal((await f.driver.prepare(f.job,{interactionPlan:plan,textEntryMode:'humanized'})).ready,true);
  assert.equal(f.actions.filter(a=>a.action==='paste'&&a.scope==='search').length,1);assert.equal(f.actions.filter(a=>a.action==='searchEnter').length,1);
  assert.equal(f.actions.some(a=>a.action==='type'||a.action==='typeText'),false);
  const chunks=['你','好','\n','👩‍💻','😊'];let prefix='';
  for(const text of chunks){
    const observed=await f.driver.observe(f.job);assert.equal(observed.draft,prefix);
    assert.equal((await f.driver.typeGrapheme(f.job,{expectedDraft:prefix,text,editorToken:observed.editorToken,activityRevision:observed.activityRevision},{canInput:()=>true})).performed,true);prefix+=text;
    assert.equal((await f.driver.prepare(f.job,{interactionPlan:plan,textEntryMode:'humanized'})).ready,true);
  }
  const typed=f.actions.filter(a=>a.action==='typeText');assert.deepEqual(typed.map(a=>a.text),chunks);assert.deepEqual(typed.map(a=>a.expectedText),['你','你好','你好\n','你好\n👩‍💻','你好\n👩‍💻😊']);
  assert.equal(typed[2].newlineKey,'Shift+Enter');assert.equal(f.actions.some(a=>a.action==='readDraft'||a.action==='paste'&&a.scope==='editor'),false);
  const ready=await f.driver.observe(f.job);assert.equal((await f.driver.submit(f.job,{expectedDraft:prefix,editorToken:ready.editorToken,activityRevision:ready.activityRevision},{canSubmit:()=>true})).performed,true);
  assert.equal(f.actions.filter(a=>a.action==='submitTextEnter').length,1);assert.equal(f.actions.filter(a=>a.action==='beginFocusHandoff').length,1);assert.equal(f.actions.filter(a=>a.action==='releaseFocusHandoff').length,1);
});

test('accepted OCR grapheme interruption resumes the prefix without repeating search or the accepted character',async t=>{
  const f=fixture(t,withObservedPopups),plan={sendMode:'focus-handoff',textEntryMode:'humanized'};
  await f.driver.prepare(f.job,{interactionPlan:plan,textEntryMode:'humanized'});
  const original=f.driver.client.request;let interrupt=true;
  f.driver.client.request=async(action,input)=>{const result=await original(action,input);if(action==='typeText'&&interrupt){interrupt=false;delete result.postPasteFrame;result.interrupted=true;f.setRevision(1);}return result;};
  const before=await f.driver.observe(f.job);assert.equal((await f.driver.typeGrapheme(f.job,{expectedDraft:'',text:'你',editorToken:before.editorToken,activityRevision:before.activityRevision},{canInput:()=>true})).performed,true);
  f.job.index=1;assert.equal((await f.driver.prepare(f.job,{interactionPlan:plan,textEntryMode:'humanized'})).ready,true);
  const after=await f.driver.observe(f.job);assert.equal(after.draft,'你');assert.equal((await f.driver.typeGrapheme(f.job,{expectedDraft:'你',text:'好',editorToken:after.editorToken,activityRevision:after.activityRevision},{canInput:()=>true})).performed,true);
  assert.deepEqual(f.actions.filter(a=>a.action==='typeText').map(a=>a.text),['你','好']);assert.equal(f.actions.filter(a=>a.action==='paste'&&a.scope==='search').length,1);assert.equal(f.actions.filter(a=>a.action==='resumeTextEnterProof').length,1);assert.equal(f.actions.some(a=>a.action==='readDraft'),false);
  const ready=await f.driver.observe(f.job);assert.equal((await f.driver.submit(f.job,{expectedDraft:'你好',editorToken:ready.editorToken,activityRevision:ready.activityRevision},{canSubmit:()=>true})).performed,true);assert.equal(f.actions.filter(a=>a.action==='submitTextEnter').length,1);
});

test('OCR typed proof rejects an altered intent and never repeats uncertain native input',async t=>{
  const f=fixture(t,withObservedPopups);await f.driver.prepare(f.job,{interactionPlan:{sendMode:'focus-handoff'},textEntryMode:'humanized'});
  const original=f.driver.client.request;f.driver.client.request=async(action,input)=>{const result=await original(action,input);if(action==='typeText')result.intendedText='另';return result;};
  const before=await f.driver.observe(f.job);await assert.rejects(f.driver.typeGrapheme(f.job,{expectedDraft:'',text:'你',editorToken:before.editorToken,activityRevision:before.activityRevision},{canInput:()=>true}),{code:'UI_QT_TYPED_TEXT_UNCONFIRMED'});
  assert.equal(f.actions.filter(a=>a.action==='typeText').length,1);assert.equal(f.driver.current,null);assert.equal(f.actions.some(a=>a.action==='submitTextEnter'),false);
});

test('UIA control verification follows navigation and precedes each text input and submission',async t=>{
  const f=fixture(t,withObservedPopups),checks=[];
  f.driver.verifyControls=async options=>{checks.push(options.operation);assert.equal(options.binding.hwnd,'100');assert.equal(options.binding.pid,f.driver.frame.binding.pid);assert.equal(options.job.text,undefined);assert.deepEqual(options.config.layout.editor,f.driver.config.layout.editor);return{verified:true,proof:'uia-controls-v1'};};
  await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}});assert.deepEqual(checks,['prepare']);
  const before=await f.driver.observe(f.job);assert.equal((await f.driver.pasteText(f.job,{expectedDraft:'',text:'正文',editorToken:before.editorToken,activityRevision:before.activityRevision},{canInput:()=>true})).performed,true);
  const pasted=await f.driver.observe(f.job);assert.equal((await f.driver.submit(f.job,{expectedDraft:'正文',editorToken:pasted.editorToken,activityRevision:pasted.activityRevision},{canSubmit:()=>true})).performed,true);
  assert.deepEqual(checks,['prepare','text-input','text-submit']);assert.equal(f.actions.filter(a=>a.action==='submitTextEnter').length,1);assert.equal(f.actions.filter(a=>a.action==='releaseFocusHandoff').length,1);
});

test('Qt text submission completes read-only UIA checks before awaiting its receipt barrier and sends once afterward',async t=>{
  const f=fixture(t,withObservedPopups),checks=[];let entered,finish;
  f.driver.verifyControls=async({operation})=>{checks.push(operation);return{verified:true,proof:'uia-controls-v1'};};
  await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}});
  const before=await f.driver.observe(f.job);await f.driver.pasteText(f.job,{expectedDraft:'',text:'正文',editorToken:before.editorToken,activityRevision:before.activityRevision},{canInput:()=>true});
  const pasted=await f.driver.observe(f.job),barrierEntered=new Promise(resolve=>{entered=resolve;});
  assert.equal(f.driver.textSubmitPreparationPolicy,'receipt-barrier-v1');
  const pending=f.driver.submit(f.job,{expectedDraft:'正文',editorToken:pasted.editorToken,activityRevision:pasted.activityRevision},{canSubmit:()=>true,beforeSubmit:()=>{entered();return new Promise(resolve=>{finish=resolve;});}});
  await barrierEntered;assert.equal(checks.at(-1),'text-submit');assert.equal(f.actions.some(action=>action.action==='submitTextEnter'),false);
  finish({ready:true,proof:'receipt-baseline-persisted-v1'});assert.equal((await pending).performed,true);
  assert.equal(f.actions.filter(action=>action.action==='submitTextEnter').length,1);assert.equal(f.actions.filter(action=>action.action==='releaseFocusHandoff').length,1);
});

test('Qt receipt wait never bypasses acknowledgment, cancellation, permission or transaction checks',async t=>{
  for(const kind of ['invalid','failed','aborted','revoked','transaction']){
    const f=fixture(t,withObservedPopups),abort=new AbortController();let allowed=true;
    await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}});
    const before=await f.driver.observe(f.job);await f.driver.pasteText(f.job,{expectedDraft:'',text:'正文',editorToken:before.editorToken,activityRevision:before.activityRevision},{canInput:()=>true});
    const pasted=await f.driver.observe(f.job),result=await f.driver.submit(f.job,{expectedDraft:'正文',editorToken:pasted.editorToken,activityRevision:pasted.activityRevision,signal:abort.signal},{canSubmit:()=>allowed,beforeSubmit:async()=>{
      if(kind==='failed')throw Object.assign(Error('Reader failed'),{code:'UI_RECEIPT_HTTP_FAILED'});
      if(kind==='aborted')abort.abort();if(kind==='revoked')allowed=false;if(kind==='transaction')f.driver.transaction.revision++;
      return kind==='invalid'?{ready:true}:{ready:true,proof:'receipt-baseline-persisted-v1'};
    }});
    assert.equal(result.performed,false,kind);assert.equal(result.attempted,false,kind);assert.equal(f.actions.some(action=>action.action==='submitTextEnter'),false,kind);
    assert.equal(f.actions.filter(action=>action.action==='releaseFocusHandoff').length,1,kind);
  }
});

test('receipt barriers are rejected outside text submission before any UI action',async t=>{
  const f=fixture(t),before=f.actions.length;
  await assert.rejects(f.driver.sendAction('paste',f.job,{}, {beforeSubmit:async()=>({ready:true,proof:'receipt-baseline-persisted-v1'})}),{code:'UI_RECEIPT_BARRIER_INVALID'});
  await assert.rejects(f.driver.sendAction('submit',f.job,{}, {beforeSubmit:true}),{code:'UI_RECEIPT_BARRIER_INVALID'});
  assert.equal(f.actions.length,before);
});

test('explicit input-boundary UIA policy omits preparation checks but freshly verifies both text input and submission',async t=>{
  const f=fixture(t,withObservedPopups,{controlVerificationPolicy:'input-boundaries-v1',verifyControls:async()=>({verified:true,proof:'uia-controls-v1'})}),checks=[];
  f.driver.verifyControls=async({operation})=>{checks.push(operation);return{verified:true,proof:'uia-controls-v1'};};
  await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}});assert.deepEqual(checks,[]);
  const before=await f.driver.observe(f.job);assert.equal((await f.driver.pasteText(f.job,{expectedDraft:'',text:'正文',editorToken:before.editorToken,activityRevision:before.activityRevision},{canInput:()=>true})).performed,true);
  const pasted=await f.driver.observe(f.job);assert.equal((await f.driver.submit(f.job,{expectedDraft:'正文',editorToken:pasted.editorToken,activityRevision:pasted.activityRevision},{canSubmit:()=>true})).performed,true);
  assert.deepEqual(checks,['text-input','text-submit']);assert.equal(f.actions.filter(a=>a.action==='submitTextEnter').length,1);
});

test('input-boundary policy preserves cancellation and transaction guards and cannot silently remove the verifier',async t=>{
  for(const policy of ['unknown',null])assert.throws(()=>new QtVisualDriver({root:os.tmpdir(),config:config(),client:{request(){}},verifyControls:async()=>({}),controlVerificationPolicy:policy}),{code:'UI_QT_CONTROLS_POLICY_INVALID'});
  assert.throws(()=>new QtVisualDriver({root:os.tmpdir(),config:config(),client:{request(){}},controlVerificationPolicy:'input-boundaries-v1'}),{code:'UI_QT_CONTROLS_POLICY_INVALID'});
  for(const kind of ['cancel','transaction']){
    const f=fixture(t,withObservedPopups,{controlVerificationPolicy:'input-boundaries-v1',verifyControls:async()=>{throw Error('preparation should defer provider work');}});
    await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}});const frame=structuredClone(f.driver.frame),abort=new AbortController();
    if(kind==='cancel')abort.abort();else f.driver.transaction.revision++;
    await assert.rejects(f.driver.verifyControlBinding(f.job,frame,'prepare',abort.signal));assert.equal(f.actions.filter(a=>a.action==='releaseFocusHandoff').length,1);
  }
});

test('new UIA text and voice leases settle only read-only header captures before the first navigation input',async t=>{
  for(const voice of [false,true]){
    const f=fixture(t,withObservedPopups);if(voice)f.driver.config.voice=adaptiveVoiceCalibration();
    let tick=Date.now(),acquiredAt,initialCaptures=0,navigated=false;const request=f.driver.client.request,initialWaits=[];
    f.driver.now=()=>tick;f.driver.wait=async ms=>{tick+=ms;if(!navigated)initialWaits.push({ms,afterCapture:initialCaptures});};f.driver.verifyControls=async()=>({verified:true,proof:'uia-controls-v1'});
    f.driver.client.request=async(action,values)=>{
      if(action==='beginFocusHandoff')acquiredAt=tick;
      if(action==='capture'&&acquiredAt!==undefined&&!navigated){initialCaptures++;if(initialCaptures<=2)throw Object.assign(Error('redraw'),{code:'QT_PIXELS_CHANGED',attempted:false,pixelMismatch:{stage:'capture',anchorIndex:0}});f.setHeader((initialCaptures===3?'a':'b').repeat(64));}
      if(action==='chord'&&values.key==='Control+F'){assert.equal(tick-acquiredAt,70);assert.equal(initialCaptures,3);assert.deepEqual(initialWaits,[{ms:35,afterCapture:1},{ms:35,afterCapture:2}]);navigated=true;}
      return request(action,values);
    };
    if(voice){const fresh=await f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff'}});await fresh.releaseFocus();}
    else{assert.equal((await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}})).ready,true);await f.driver.releaseTextFocus();}
    assert.equal(navigated,true);assert.equal(f.actions.filter(a=>a.action==='chord'&&a.key==='Control+F').length,1);
  }
});

test('fresh UIA navigation consumes one native double-read capture with zero scheduled foreground wait',async t=>{
  for(const voice of [false,true]){
    const f=fixture(t,withObservedPopups);if(voice)f.driver.config.voice=adaptiveVoiceCalibration();let captured=0,navigated=false;const waits=[],request=f.driver.client.request;
    f.driver.wait=async ms=>{if(!navigated)waits.push(ms);};f.driver.verifyControls=async()=>({verified:true,proof:'uia-controls-v1'});
    f.driver.client.request=async(action,values)=>{if(action==='capture'&&!navigated)captured++;if(action==='chord'&&values.key==='Control+F'){assert.equal(captured,1);assert.deepEqual(waits,[]);navigated=true;}return request(action,values);};
    if(voice){const fresh=await f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff'}});await fresh.releaseFocus();}
    else{assert.equal((await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}})).ready,true);await f.driver.releaseTextFocus();}
    assert.equal(navigated,true);
  }
});

test('UIA initial navigation stops on changed binding, activity, cancellation or its 400ms bound',async t=>{
  for(const kind of ['pid','epoch','revision','lastInputTick','focusHwnd','position','idle','lease','cancel','endless']){
    const f=fixture(t,withObservedPopups),abort=new AbortController(),request=f.driver.client.request;let tick=Date.now(),captured=0,refusedChords=0;
    f.driver.now=()=>tick;f.driver.wait=async ms=>{tick+=ms;};f.driver.verifyControls=async()=>({verified:true,proof:'uia-controls-v1'});
    f.driver.client.request=async(action,values)=>{
      if(action==='chord'&&values.key==='Control+F'){refusedChords++;throw Object.assign(Error('redraw'),{code:'QT_PIXELS_CHANGED',attempted:false,pixelMismatch:{stage:'guard',anchorIndex:0}});}
      const frame=await request(action,values);if(action==='capture'){
      captured++;if(kind==='cancel')abort.abort();
      if(captured===2){if(kind==='pid')frame.binding.pid++;if(kind==='epoch')frame.epoch='3'.repeat(32);if(kind==='revision')frame.revision++;if(kind==='lastInputTick')frame.binding.lastInputTick++;if(kind==='focusHwnd')frame.binding.focusHwnd='101';if(kind==='position'){frame.binding.captureRect.left++;frame.binding.captureRect.right++;}if(kind==='idle')frame.idleMs=0;if(kind==='lease')f.driver.textFocusLease={...f.driver.textFocusLease};}
    }return frame;};
    const started=tick;let refused;
    try{refused=await f.driver.prepare(f.job,{signal:abort.signal,interactionPlan:{executionMode:'focus-handoff'}});}catch(error){refused={ready:false,reason:error.code};}
    assert.equal(refused?.ready,false,kind);
    assert.ok(tick-started<=400);assert.equal(f.actions.some(a=>['chord','paste','type','searchEnter'].includes(a.action)),false);assert.equal(f.actions.filter(a=>a.action==='releaseFocusHandoff').length,1);
    if(kind==='endless'){assert.ok(captured>=10);assert.ok(refusedChords>=10);}else assert.ok(captured<=2);
  }
});

test('UIA redraw settling refreshes an expired pre-focus account proof against the same binding without widening its age limit',async t=>{
  const f=fixture(t,withObservedPopups),request=f.driver.client.request,probe=f.driver.probeAccount;let tick=Date.now(),probes=0,navigated=false;
  f.driver.now=()=>tick;f.driver.wait=async ms=>{tick+=ms;};f.driver.verifyControls=async()=>({verified:true,proof:'uia-controls-v1'});
  f.driver.probeAccount=async args=>{probes++;if(probes===2){assert.equal(f.actions.some(a=>a.action==='chord'),false);assert.equal(args.binding.pid,42);}return probe(args);};
  f.driver.client.request=async(action,values)=>{if(action==='chord')navigated=true;const result=await request(action,values);if(action==='beginFocusHandoff')tick+=450;if(action==='capture'&&!navigated)tick+=60;return result;};
  assert.equal((await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}})).ready,true);assert.equal(probes,2);await f.driver.releaseTextFocus();
});

test('a navigation guard refusal outside header anchor zero is never retried',async t=>{
  const f=fixture(t,withObservedPopups);let tick=Date.now();f.driver.now=()=>tick;f.driver.wait=async ms=>{tick+=ms;};f.driver.verifyControls=async()=>({verified:true,proof:'uia-controls-v1'});
  f.setFailure('chord','QT_PIXELS_CHANGED',{attempted:false,pixelMismatch:{stage:'guard',anchorIndex:1}});
  const result=await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}});assert.equal(result.ready,false);assert.equal(result.reason,'QT_PIXELS_CHANGED');
  assert.equal(f.actions.filter(a=>a.action==='chord'&&a.key==='Control+F').length,1);assert.equal(f.actions.some(a=>['paste','type','searchEnter'].includes(a.action)),false);assert.equal(f.actions.filter(a=>a.action==='releaseFocusHandoff').length,1);
});

test('only an unexecuted UIA opening chord may refresh its header and the successful frame becomes the transition baseline',async t=>{
  const f=fixture(t,withObservedPopups,{verifyControls:async()=>({verified:true,proof:'uia-controls-v1'})}),request=f.driver.client.request,transition=f.driver.waitForSearchEnterTransition.bind(f.driver);
  let tick=Date.now(),chords=0,captures=0,firstToken,finalToken,transitionMs;
  f.driver.now=()=>tick;f.driver.wait=async ms=>{tick+=ms;};
  f.driver.client.request=async(action,input)=>{
    if(action==='chord'&&input.key==='Control+F'&&++chords===1){firstToken=input.token;f.setHeader('b'.repeat(64));throw Object.assign(Error('redraw'),{code:'QT_PIXELS_CHANGED',attempted:false,pixelMismatch:{stage:'guard',anchorIndex:0}});}
    if(action==='chord'&&input.key==='Control+F')finalToken=input.token;
    const result=await request(action,input);if(action==='searchEnter')f.setHeader('b'.repeat(64));if(action==='capture')result.token=(++captures).toString(16).padStart(32,'0');return result;
  };
  f.driver.waitForSearchEnterTransition=async baseline=>{assert.equal(baseline.regions[0].rgbaSha256,'b'.repeat(64));assert.equal(baseline.token,finalToken);const start=tick,result=await transition(baseline);transitionMs=tick-start;return result;};
  assert.equal((await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}})).ready,true);
  assert.equal(chords,2);assert.notEqual(firstToken,finalToken);assert.ok(transitionMs>=350);
  assert.equal(f.actions.filter(a=>a.action==='paste'&&a.scope==='search').length,1);assert.equal(f.actions.filter(a=>a.action==='searchEnter').length,1);
});

test('UIA opening retry refuses unknown execution, other guards and non-UIA navigation',async t=>{
  for(const kind of ['attempted','unknown','capture-stage','other-anchor','activity','non-uia']){
    const f=fixture(t,withObservedPopups,kind==='non-uia'?{}:{verifyControls:async()=>({verified:true,proof:'uia-controls-v1'})}),request=f.driver.client.request;let chords=0;
    f.driver.client.request=async(action,input)=>{
      if(action==='chord'&&input.key==='Control+F'){chords++;throw Object.assign(Error('refused'),{code:kind==='activity'?'QT_HUMAN_ACTIVITY_CHANGED':'QT_PIXELS_CHANGED',...(kind!=='unknown'?{attempted:kind==='attempted'}:{}),pixelMismatch:{stage:kind==='capture-stage'?'capture':'guard',anchorIndex:kind==='other-anchor'?1:0}});}
      return request(action,input);
    };
    try{assert.equal((await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}})).ready,false);}catch(error){assert.match(error.code,/^(QT_|UI_QT_)/);}
    assert.equal(chords,1,kind);assert.equal(f.actions.some(a=>['paste','searchEnter'].includes(a.action)),false,kind);
  }
});

test('a successful opening chord is never repeated when its response crosses the redraw budget',async t=>{
  const f=fixture(t,withObservedPopups,{verifyControls:async()=>({verified:true,proof:'uia-controls-v1'})}),request=f.driver.client.request;let tick=Date.now(),chords=0;
  f.driver.now=()=>tick;f.driver.wait=async ms=>{tick+=ms;};
  f.driver.client.request=async(action,input)=>{const result=await request(action,input);if(action==='chord'&&input.key==='Control+F'){chords++;tick+=401;}return result;};
  assert.equal((await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}})).ready,true);assert.equal(chords,1);
});

test('UIA verification refusal returns text focus before body input without submitting or retrying',async t=>{
  for(const kind of ['false','exception','binding','cancel']){
    const f=fixture(t,withObservedPopups);await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}});const before=await f.driver.observe(f.job),abort=new AbortController();f.actions.length=0;
    f.driver.verifyControls=async()=>{if(kind==='exception')throw Error('private provider detail');if(kind==='binding')f.driver.transaction.revision++;if(kind==='cancel')abort.abort();return{verified:kind!=='false',proof:'uia-controls-v1'};};
    const result=await f.driver.pasteText(f.job,{expectedDraft:'',text:'正文',editorToken:before.editorToken,activityRevision:before.activityRevision,signal:abort.signal},{canInput:()=>true});
    assert.equal(result.attempted,false);assert.equal(f.actions.some(a=>['paste','type','click','submitTextEnter'].includes(a.action)),false);assert.equal(f.actions.filter(a=>a.action==='releaseFocusHandoff').length,1);assert.equal(f.driver.textFocusLease,null);
  }
});

test('fresh UIA preparation refusal carries only this attempt successful focus cleanup and no body input',async t=>{
  for(const navigation of [false,true]){
    const fail=()=>{throw Object.assign(Error('private provider failure'),{code:'UIA_MODE_RESULT_UNCONFIRMED',nativeReason:'UI_CONTROLS_LAYOUT_CHANGED'});};
    const f=navigation?uiaFirstNavigationFixture(t,{mutateProof:fail}):fixture(t,withObservedPopups,{verifyControls:fail});
    let error;try{await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}});}catch(value){error=value;}
    assert.equal(error?.code,'UIA_MODE_RESULT_UNCONFIRMED');assert.equal(error.attempted,false);
    assert.deepEqual(error.uiaPreparationRefusal,{version:1,stage:'control-preparation',operation:navigation?'navigation-ready':'prepare',focus:'restored',messageInputAttempted:false,draftPresent:false,cleanupConfirmed:true});
    assert.equal(error.nativeReason,'UI_CONTROLS_LAYOUT_CHANGED');
    assert.equal(f.actions.filter(action=>action.action==='releaseFocusHandoff').length,1);
    assert.equal(f.actions.some(action=>action.action==='submitTextEnter'||action.action==='pasteImage'||action.action==='paste'&&action.scope==='editor'),false);
  }
});

test('UIA preparation cannot declare a safe pause for partial drafts or failed popup, helper, or focus cleanup',async t=>{
  for(const kind of ['partial','popup','helper','focus']){
    const f=fixture(t,withObservedPopups,{verifyControls:async()=>{throw Object.assign(Error('private provider failure'),{code:kind==='helper'?'UIA_MODE_VERIFIER_CLEANUP_UNCONFIRMED':'UIA_MODE_RESULT_UNCONFIRMED'});}});
    if(kind==='partial')f.job.pendingInput={text:'existing',index:0};
    if(kind==='popup')f.driver.closePreparationPopupAfterFailure=async()=>{throw Object.assign(Error('popup failed'),{code:'UI_QT_SEARCH_CLEANUP_UNCONFIRMED'});};
    if(kind==='focus')f.driver.releaseTextFocus=async()=>{throw Object.assign(Error('return failed'),{code:'UI_QT_FOCUS_RETURN_UNCONFIRMED'});};
    const refused=await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}}).catch(error=>error);
    assert.notEqual(refused.ready,true,kind);assert.equal(refused.uiaPreparationRefusal,undefined,kind);if(kind!=='partial')assert.ok(refused instanceof Error,kind);
    assert.equal(f.actions.some(action=>action.action==='submitTextEnter'||action.action==='pasteImage'||action.action==='paste'&&action.scope==='editor'),false);
  }
});

test('specific UIA binding refusals remain visible after control verification and focus cleanup',async t=>{
  const f=fixture(t,withObservedPopups);await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}});const before=await f.driver.observe(f.job);f.actions.length=0;
  f.driver.verifyControls=async()=>{throw Object.assign(Error('private provider detail'),{code:'UIA_MODE_GEOMETRY_CHANGED'});};
  const result=await f.driver.pasteText(f.job,{expectedDraft:'',text:'正文',editorToken:before.editorToken,activityRevision:before.activityRevision},{canInput:()=>true});
  assert.deepEqual(result,{performed:false,attempted:false,reason:'UIA_MODE_GEOMETRY_CHANGED'});
  assert.equal(f.actions.some(a=>['paste','type','click','submitTextEnter'].includes(a.action)),false);assert.equal(f.actions.filter(a=>a.action==='releaseFocusHandoff').length,1);
});

test('UIA image checks run before paste and submit, with an applied draft retained on refusal',async t=>{
  for(const policy of ['all-operations','input-boundaries-v1']){
  const f=fixture(t,withObservedPopups),checks=[];f.job.image={path:path.join(f.driver.root,'fixture.png'),sha256:'a'.repeat(64)};
  f.driver.controlVerificationPolicy=policy;
  f.driver.verifyControls=async({operation})=>{checks.push(operation);return{verified:operation!=='image-submit',proof:'uia-controls-v1'};};
  await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}});const original=f.driver.client.request;
  f.driver.client.request=async(action,input)=>{if(action==='pasteImage'){f.actions.push({action,...input});f.setEditor('8'.repeat(64));return{performed:true,attempted:true,pasteApplied:true,clipboardRestored:true,revision:0};}return original(action,input);};
  assert.equal((await f.driver.pasteImage(f.job,await f.driver.observe(f.job),{canInput:()=>true})).performed,true);f.actions.length=0;
  await assert.rejects(f.driver.submitImage(f.job,await f.driver.observe(f.job),{canSubmit:()=>true}),{code:'UI_QT_CONTROLS_UNVERIFIED'});
  assert.deepEqual(checks,[...(policy==='all-operations'?['prepare']:[]),'image-input','image-submit']);assert.equal(f.actions.some(a=>a.action==='click'),false);assert.equal(f.driver.textResume.imageApplied,f.job.id);assert.equal(f.actions.filter(a=>a.action==='releaseFocusHandoff').length,1);
  }
});

test('input-boundary UIA policy still freshly refuses voice-start before transferring the recording lease',async t=>{
  const f=fixture(t,withObservedPopups,{controlVerificationPolicy:'input-boundaries-v1',verifyControls:async()=>({verified:false})});f.driver.config.voice=adaptiveVoiceCalibration();const checks=[];
  f.driver.verifyControls=async({operation})=>{checks.push(operation);return{verified:false};};
  await assert.rejects(f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff'}}),{code:'UI_QT_CONTROLS_UNVERIFIED'});
  assert.deepEqual(checks,['voice-start']);assert.equal(f.actions.some(a=>a.action==='transferFocusHandoff'),false);assert.equal(f.actions.filter(a=>a.action==='releaseFocusHandoff').length,1);
});

test('UIA preparation and voice-start refusal release the owned lease before a recording session can transfer',async t=>{
  for(const rejected of ['prepare','voice-start']){
    const f=fixture(t,withObservedPopups);f.driver.config.voice=voiceCalibration();const checks=[];
    f.driver.verifyControls=async({operation,binding})=>{checks.push(operation);assert.equal(binding.hwnd,'100');return{verified:operation!==rejected,proof:'uia-controls-v1'};};
    await assert.rejects(f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff'}}),{code:'UI_QT_CONTROLS_UNVERIFIED'});
    assert.deepEqual(checks,rejected==='prepare'?['prepare']:['prepare','voice-start']);assert.equal(f.actions.some(a=>a.action==='transferFocusHandoff'),false);assert.equal(f.actions.filter(a=>a.action==='releaseFocusHandoff').length,1);
  }
});

test('UIA failure never converts an unconfirmed focus cleanup into a safe input refusal',async t=>{
  const f=fixture(t,withObservedPopups);await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}});const before=await f.driver.observe(f.job);
  f.driver.verifyControls=async()=>({verified:false});f.driver.releaseTextFocus=async()=>{throw Object.assign(Error('cleanup'),{code:'UI_QT_FOCUS_RETURN_UNCONFIRMED'});};
  await assert.rejects(f.driver.pasteText(f.job,{expectedDraft:'',text:'正文',editorToken:before.editorToken,activityRevision:before.activityRevision},{canInput:()=>true}),{code:'UI_QT_FOCUS_RETURN_UNCONFIRMED'});
});

test('UIA verifier cleanup uncertainty propagates after text or image focus is returned',async t=>{
  for(const image of [false,true]){
    const f=fixture(t,withObservedPopups);await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}});const before=await f.driver.observe(f.job);f.actions.length=0;
    f.driver.verifyControls=async()=>{throw Object.assign(Error('private helper details'),{code:'UIA_MODE_VERIFIER_CLEANUP_UNCONFIRMED'});};
    f.job.image={path:path.join(f.driver.root,'fixture.png'),sha256:'a'.repeat(64)};
    const operation=image?f.driver.pasteImage(f.job,before,{canInput:()=>true}):f.driver.pasteText(f.job,{expectedDraft:'',text:'正文',editorToken:before.editorToken,activityRevision:before.activityRevision},{canInput:()=>true});
    await assert.rejects(operation,{code:'UIA_MODE_VERIFIER_CLEANUP_UNCONFIRMED',controlsCleanupFailed:true});
    assert.equal(f.actions.filter(a=>a.action==='releaseFocusHandoff').length,1);assert.equal(f.actions.some(a=>['paste','pasteImage','submitTextEnter'].includes(a.action)),false);
  }
});

test('image paste and submit require the same prepared target and never use text markers',async t=>{
  const f=fixture(t);await f.driver.prepare(f.job);f.job.image={path:path.join(f.driver.root,'fixture.png'),sha256:'a'.repeat(64)};
  const original=f.driver.client.request;f.driver.client.request=async(action,input)=>{
    if(action==='pasteImage'){f.actions.push({action,...input});f.setEditor('8'.repeat(64));return{performed:true,attempted:true,pasteApplied:true,clipboardRestored:true,revision:0};}
    return original(action,input);
  };
  const before=await f.driver.observe(f.job);f.actions.length=0;
  assert.equal((await f.driver.pasteImage(f.job,before,{canInput:()=>true})).imageApplied,true);
  const applied=await f.driver.observe(f.job);assert.equal(applied.appliedImageId,f.job.id);assert.equal(applied.draft,undefined);
  assert.equal((await f.driver.submitImage(f.job,applied,{canSubmit:()=>false})).attempted,false);
  assert.equal((await f.driver.submitImage(f.job,applied,{canSubmit:()=>true})).performed,true);
  assert.equal(f.actions.filter(row=>row.action==='pasteImage').length,1);assert.equal(f.actions.filter(row=>row.action==='click').length,1);
  assert.equal(f.actions.some(row=>['paste','type','submitTextEnter'].includes(row.action)),false);
  assert.equal((await f.driver.submitImage(f.job,applied,{canSubmit:()=>true})).attempted,false);
});

test('image paste refuses changed chat, revoked authorization and uncertain clipboard restoration',async t=>{
  for(const mode of ['header','authorization','clipboard']){
    const f=fixture(t);await f.driver.prepare(f.job);f.job.image={path:path.join(f.driver.root,'fixture.png'),sha256:'a'.repeat(64)};
    const observed=await f.driver.observe(f.job);f.actions.length=0;
    if(mode==='header')f.setHeader('9'.repeat(64));
    if(mode==='clipboard')f.setFailure('pasteImage','DRAFT_CLIPBOARD_RESTORE_UNCONFIRMED',{attempted:false,clipboardRestored:false});
    const operation=f.driver.pasteImage(f.job,observed,{canInput:()=>mode!=='authorization'});
    if(mode==='clipboard'){await assert.rejects(operation,{code:'DRAFT_CLIPBOARD_RESTORE_UNCONFIRMED'});assert.deepEqual(f.driver.draftHold,{account:f.job.account,target:f.job.target});}
    else{assert.equal((await operation).attempted,false);assert.equal(f.actions.some(row=>row.action==='pasteImage'),false);}
  }
});

test('GIF animation uses stable send anchors and submits once without flattening or draft readback',async t=>{
  const f=fixture(t);await f.driver.prepare(f.job);f.job.image={path:path.join(f.driver.root,'fixture.gif'),sha256:'a'.repeat(64),format:'gif'};
  const request=f.driver.client.request;let pasted=false;
  f.driver.client.request=async(action,input)=>{
    if(action==='pasteImage'){f.actions.push({action,...input});pasted=true;return{performed:true,attempted:true,pasteApplied:true,clipboardRestored:true,revision:0,imageFormat:'gif',originalFilePasted:true};}
    if(pasted&&action==='capture')assert.equal(input.regions.some(rect=>JSON.stringify(rect)===JSON.stringify(f.driver.config.layout.editor)),false);
    return request(action,input);
  };
  const observed=await f.driver.observe(f.job);f.actions.length=0;
  assert.equal((await f.driver.pasteImage(f.job,observed,{canInput:()=>true})).imageApplied,true);
  f.setEditor('9'.repeat(64));const ready=await f.driver.observe(f.job);assert.equal(ready.ready,true);
  assert.equal((await f.driver.submitImage(f.job,ready,{canSubmit:()=>true})).performed,true);
  assert.equal(f.actions.filter(row=>row.action==='pasteImage').length,1);assert.equal(f.actions.filter(row=>row.action==='click').length,1);
  assert.equal(f.actions.some(row=>['readDraft','paste','type'].includes(row.action)),false);
});

test('GIF cannot accept a native raster paste or resume across intervening human input',async t=>{
  const f=fixture(t);await f.driver.prepare(f.job);f.job.image={path:path.join(f.driver.root,'fixture.gif'),sha256:'a'.repeat(64),format:'gif'};
  const request=f.driver.client.request;f.driver.client.request=async(action,input)=>action==='pasteImage'?{performed:true,attempted:true,pasteApplied:true,clipboardRestored:true,revision:0,imageFormat:'static',originalFilePasted:false}:request(action,input);
  await assert.rejects(f.driver.pasteImage(f.job,await f.driver.observe(f.job),{canInput:()=>true}),{code:'UI_QT_IMAGE_PASTE_UNCONFIRMED'});
  const changed=await pastedImageFixture(t);changed.driver.textResume.imageFormat='gif';changed.job.image.format='gif';
  assert.deepEqual(await changed.driver.resumeImage(changed.job,{canInput:()=>true}),{ready:false,reason:'UI_QT_IMAGE_DRAFT_CHANGED'});
  assert.equal(changed.actions.some(row=>['pasteImage','click'].includes(row.action)),false);
});

async function pastedImageFixture(t){
  const f=fixture(t,withObservedPopups);f.job.image={path:path.join(f.driver.root,'fixture.png'),sha256:'a'.repeat(64)};
  await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}});
  const request=f.driver.client.request;
  f.driver.client.request=async(action,input)=>{
    if(action==='pasteImage'){f.actions.push({action,...input});f.setEditor('8'.repeat(64));return{performed:true,attempted:true,pasteApplied:true,clipboardRestored:true,revision:f.driver.current.revision};}
    return request(action,input);
  };
  const before=await f.driver.observe(f.job);await f.driver.pasteImage(f.job,before,{canInput:()=>true});
  await f.driver.releaseTextFocus();f.setRevision(1);f.actions.length=0;return f;
}

test('a pasted image resumes its original draft after focus return without contact search, paste or text input',async t=>{
  const f=await pastedImageFixture(t),previous=structuredClone(f.driver.textResume);
  assert.equal(f.driver.canResumeImage(f.job),true);assert.equal((await f.driver.observe(f.job)).ready,false);
  assert.deepEqual(await f.driver.resumeImage(f.job,{canInput:()=>true}),{ready:true,imageResume:true});
  assert.equal(f.driver.current.revision,1);assert.equal(f.driver.current.imageApplied,f.job.id);assert.equal(f.driver.current.editor,previous.editor);
  assert.equal(f.actions.find(row=>row.action==='beginFocusHandoff').includesContactNavigation,false);
  assert.equal(f.actions.some(row=>['chord','type','paste','pasteImage','readDraft','searchEnter','resumeTextEnterProof','click'].includes(row.action)),false);
  const observed=await f.driver.observe(f.job);assert.equal(observed.appliedImageId,f.job.id);
  assert.equal((await f.driver.submitImage(f.job,observed,{canSubmit:()=>true})).performed,true);
  assert.equal(f.actions.filter(row=>row.action==='click').length,1);assert.equal(f.actions.filter(row=>row.action==='releaseFocusHandoff').length,1);
  assert.equal(f.driver.canResumeImage(f.job),false);
});

test('image resume rejects another delivery, asset, account or target before any native operation',async t=>{
  for(const change of [job=>job.id='4'.repeat(64),job=>job.image.sha256='5'.repeat(64),job=>job.account='wxid_other',job=>job.target='wxid_other']){
    const f=await pastedImageFixture(t),job=structuredClone(f.job);change(job);
    if(job.account!==f.job.account)await assert.rejects(f.driver.resumeImage(job,{canInput:()=>true}),{code:'UI_QT_PRIVATE_TARGET_REQUIRED'});
    else assert.deepEqual(await f.driver.resumeImage(job,{canInput:()=>true}),{ready:false,reason:'UI_QT_IMAGE_RESUME_UNAVAILABLE'});
    assert.equal(f.actions.length,0);
  }
  const f=await pastedImageFixture(t);f.driver.textResume=null;
  assert.equal(f.driver.canResumeImage(f.job),false);assert.equal((await f.driver.resumeImage(f.job,{canInput:()=>true})).reason,'UI_QT_IMAGE_RESUME_UNAVAILABLE');assert.equal(f.actions.length,0);
});

test('changed image pixels, header, process, geometry or native epoch cannot navigate or submit during resume',async t=>{
  for(const kind of ['editor','header','process','geometry','epoch']){
    const f=await pastedImageFixture(t),request=f.driver.client.request;
    if(kind==='editor')f.setEditor('7'.repeat(64));if(kind==='header')f.setHeader('7'.repeat(64));
    f.driver.client.request=async(action,input)=>{const result=await request(action,input);
      if(action==='inspectLayout'&&kind==='process')result.binding.processCreatedFileTimeUtc='67890';
      if(action==='inspectLayout'&&kind==='geometry')result.binding.captureRect.left++;
      if(action==='capture'&&kind==='epoch')result.epoch='6'.repeat(32);return result;
    };
    const result=await f.driver.resumeImage(f.job,{canInput:()=>true});assert.equal(result.ready,false);
    assert.equal(result.reason,['editor','header'].includes(kind)?'UI_QT_IMAGE_DRAFT_CHANGED':'UI_QT_IMAGE_RESUME_BINDING_CHANGED');
    assert.equal(f.driver.current,null);assert.equal(f.actions.some(row=>['paste','pasteImage','click','chord','type','searchEnter','readDraft'].includes(row.action)),false);
    assert.equal(f.actions.filter(row=>row.action==='beginFocusHandoff').length,f.actions.filter(row=>row.action==='releaseFocusHandoff').length);
  }
});

test('image resume rechecks authorization after account work and does not replace an applied draft with ordinary preparation',async t=>{
  const f=await pastedImageFixture(t);let allowed=true;
  const probe=f.driver.probeAccount;f.driver.probeAccount=async input=>{const value=await probe(input);allowed=false;return value;};
  assert.equal((await f.driver.resumeImage(f.job,{canInput:()=>allowed})).reason,'UI_TARGET_NOT_ALLOWED');
  assert.equal(f.actions.some(row=>row.action==='beginFocusHandoff'),false);f.actions.length=0;
  await assert.rejects(f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}}),{code:'UI_QT_IMAGE_RESUME_REQUIRED'});
  assert.equal(f.driver.canResumeImage(f.job),true);
  assert.equal(f.actions.some(row=>['paste','pasteImage','click','chord','type','searchEnter'].includes(row.action)),false);
});

test('image submission uncertainty cannot regain a resumable checkpoint or click a second time',async t=>{
  const f=await pastedImageFixture(t);await f.driver.resumeImage(f.job,{canInput:()=>true});const observed=await f.driver.observe(f.job);
  f.setFailure('click','QT_INPUT_UNCERTAIN',{attempted:true});await assert.rejects(f.driver.submitImage(f.job,observed,{canSubmit:()=>true}));
  assert.equal(f.driver.canResumeImage(f.job),false);assert.equal((await f.driver.resumeImage(f.job,{canInput:()=>true})).ready,false);
  assert.equal((await f.driver.submitImage(f.job,observed,{canSubmit:()=>true})).attempted,false);assert.equal(f.actions.filter(row=>row.action==='click').length,1);
});

test('real image queue and Qt focus-return state resume one applied image without navigation or a second paste',async t=>{
  const f=fixture(t,withObservedPopups),bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=','base64');
  const file=path.join(f.driver.root,'queued-image.png');fs.writeFileSync(file,bytes);
  const request=f.driver.client.request;
  f.driver.client.request=async(action,input)=>{if(action==='pasteImage'){f.actions.push({action,...input});f.setEditor('8'.repeat(64));return{performed:true,attempted:true,pasteApplied:true,clipboardRestored:true,revision:0};}return request(action,input);};
  let outbox,pasted=false;const paste=f.driver.pasteImage.bind(f.driver);
  f.driver.pasteImage=async(...args)=>{const result=await paste(...args);if(!pasted){pasted=true;outbox.pause(args[0].id);}return result;};
  const guarded=createImageUiDriver({native:f.driver,inputAllowed:()=>true,authorizeDelivery:()=>true,control:()=>({paused:false}),
    currentPlan:()=>({allowed:true,executionMode:'foreground',sendMode:'focus-handoff',requiresForeground:true,requiresActivityGuard:true,textEntryMode:'paste'})});
  outbox=new UiImageOutbox({directory:path.join(f.driver.root,'image-outbox'),driver:guarded,authorizeScope:()=>true,settings:{idleMs:1000,intervalMs:0},
    receipts:{prepare:async()=>({prepared:true,submissionAllowed:true}),submitted:()=>({submitted:true}),query:async()=>({confirmed:false})}});
  t.after(()=>outbox.shutdown());
  outbox.enqueue({deliveryId:f.job.id,account:f.job.account,target:f.job.target,image:{path:file,sha256:digest(bytes)},
    selectionScope:{version:1,accountRef:'a'.repeat(64),account:f.job.account,target:f.job.target,eventId:'fixture-image',selectionVersion:1,grantId:'b'.repeat(64),token:'c'.repeat(64)}});
  await outbox.tick();assert.equal(outbox.get(f.job.id).state,'paused');assert.equal(f.driver.current,null);assert.equal(f.driver.textResume.imageApplied,f.job.id);
  assert.equal(f.actions.filter(row=>row.action==='pasteImage').length,1);f.actions.length=0;f.setRevision(1);
  outbox.resume(f.job.id);await outbox.tick();assert.equal(outbox.get(f.job.id).state,'submitted');
  assert.equal(f.actions.filter(row=>row.action==='beginFocusHandoff').length,1);assert.equal(f.actions.filter(row=>row.action==='click').length,1);
  assert.equal(f.actions.some(row=>['paste','pasteImage','chord','type','searchEnter','readDraft'].includes(row.action)),false);
});

test('Qt input and preflight use one effective idle threshold, preserving explicit longer waits',async t=>{
  const f=fixture(t,withObservedPopups),source=f.driver.config,request=f.driver.client.request;
  for(const [requiredIdleMs,expected]of [[undefined,1000],[0,1000],[500,1000],[1000,1000],[10000,10000]]){
    assert.equal(createQtVisualDriver({root:f.driver.root,config:source,client:f.driver.client,requiredIdleMs}).config.idleMs,expected);
  }
  assert.equal(source.idleMs,1000);
  for(const value of [-1,1.5,NaN,'10000',300001])assert.throws(()=>createQtVisualDriver({root:f.driver.root,config:source,client:f.driver.client,requiredIdleMs:value}),{code:'UI_QT_CONFIG_INVALID'});
  f.driver.config=createQtVisualDriver({root:f.driver.root,config:source,client:f.driver.client,requiredIdleMs:10000}).config;
  let preflights=0;f.driver.client.request=async(action,input)=>{
    if(action==='inspectFocusHandoff'){preflights++;assert.equal(input.idleMs,10000);return{ready:false,reason:'QT_USER_ACTIVE',inputSent:false,clipboardAccessed:false,focusChanged:false};}
    return request(action,input);
  };
  assert.deepEqual(await f.driver.prepare(f.job,{interactionPlan:{sendMode:'focus-handoff'}}),{ready:false,reason:'QT_USER_ACTIVE'});
  assert.equal(preflights,1);assert.equal(f.actions.some(a=>a.action==='beginFocusHandoff'||a.action==='paste'||a.action==='click'),false);
});
test('Qt layout rejects missing calibration, invalid geometry and group-independent schema', () => {
  assert.equal(validateQtConfig(config()).backend,'qt-visual');
  for (const alter of [c=>delete c.layout.emptyEditorSha256,c=>c.layout.editor.right=900,c=>c.layout.send=c.layout.editor,c=>c.idleMs=0,c=>c.executableSha256='x']) {
    const c=config();alter(c);assert.throws(()=>validateQtConfig(c));
  }
});
test('separate Qt popups require explicit exact owner, class, style and geometry calibration',()=>{
  const c=withPopups(config());assert.equal(validateQtConfig(c).selfSurface.popupCalibration.ownerRelation,'same-thread-unowned');
  const owned=structuredClone(c);owned.profileSurface.popupCalibration.ownerRelation='root-owned';owned.profileSurface.popupCalibration.ownerDepth=1;assert.equal(validateQtConfig(owned).profileSurface.popupCalibration.ownerDepth,1);
  for(const mutate of [p=>p.ownerRelation='same-process',p=>p.ownerDepth=1,p=>p.className='',p=>p.className='x\0y',p=>p.style='123',p=>p.extendedStyle=4294967296,p=>p.clientWidth=359,p=>p.kind='search',p=>p.extra=true,p=>p.windowRect.left=-32769]){
    const bad=structuredClone(c);mutate(bad.selfSurface.popupCalibration);assert.throws(()=>validateQtConfig(bad),{code:'UI_QT_POPUP_CALIBRATION_INVALID'});
  }
  const outside=structuredClone(c);outside.searchPopupCalibration.windowRect.right=200;assert.throws(()=>validateQtConfig(outside),{code:'UI_QT_POPUP_CALIBRATION_INVALID'});
});
test('search field remains on main window and only observed list heights are accepted',()=>{
  const c=withPopups(config());c.searchPopupCalibration.windowRect=r(60,70,280,200);c.searchPopupCalibration.clientHeight=130;
  c.layout.searchResultIdentity=r(80,70,260,150);
  c.searchPopupCalibration.heightVariants=[280,363,400];assert.deepEqual(validateQtConfig(c).searchPopupCalibration.heightVariants,[280,363,400]);
  for(const bad of [[],[280,280],[0],[4097],[1,2,3,4,5],[280.5],['280']]){const copy=structuredClone(c);copy.searchPopupCalibration.heightVariants=bad;assert.throws(()=>validateQtConfig(copy),{code:'UI_QT_POPUP_CALIBRATION_INVALID'});}
  const profile=structuredClone(c);profile.selfSurface.popupCalibration.heightVariants=[280];assert.throws(()=>validateQtConfig(profile),{code:'UI_QT_POPUP_CALIBRATION_INVALID'});
});
test('empty editor templates preserve legacy hash and accept at most four exact confirmed images',()=>{
  const c=config(),primary=c.layout.emptyEditorSha256,other='d'.repeat(64);
  assert.deepEqual(qtEmptyEditorHashes(c.layout),[primary]);
  c.layout.emptyEditorSha256s=[primary,other];assert.deepEqual(qtEmptyEditorHashes(validateQtConfig(c).layout),[primary,other]);
  c.layout.emptyEditorSha256s=[other];assert.deepEqual(qtEmptyEditorHashes(validateQtConfig(c).layout),[primary,other]);
  for(const bad of [null,[],[other,other],['short'],['D'.repeat(64)],[other,'e'.repeat(64),'f'.repeat(64),'0'.repeat(64)],Array(5).fill(other)]){
    c.layout.emptyEditorSha256s=bad;assert.throws(()=>validateQtConfig(c),{code:'UI_QT_EMPTY_TEMPLATES_INVALID'});
  }
});
test('profile identity needs exact labeled full alias, no nickname, fuzzy normalization or duplicates', () => {
  const area=r(0,0,500,100);
  const check=text=>exactProfileAlias({words:[word(text,area)]},area,'target_A');
  assert.equal(check('微信号：target_A'),true);
  assert.equal(check('WeChat ID:target_A'),true);
  for(const wrong of ['target_A','微信号：target_a','微信号：target_Ax','昵称：target_A','微信号：ｔarget_A'])assert.equal(check(wrong),false);
  assert.equal(exactProfileAlias({words:[word('微信号：target_A',area,0),word('微信号：other',area,1)]},area,'target_A'),false);
  assert.equal(exactProfileAlias({words:[word('微信号：target_A',area,0,0.8)]},area,'target_A'),false);
});
test('profile ID wrapped on two narrow adjacent lines is compared as exact ASCII, without fuzzy repairs',()=>{
  const area=r(0,0,400,100),words=[
    {text:'微信号：',x:10,y:10,width:60,height:20,line:0,confidence:0.99},
    {text:'wxid_fixture_long',x:80,y:10,width:200,height:20,line:0,confidence:0.99},
    {text:'abc',x:80,y:35,width:40,height:20,line:1,confidence:0.99},
  ];
  assert.equal(exactProfileAlias({words},area,'wxid_fixture_longabc'),true);
  assert.equal(exactProfileAlias({words},area,'wxid_fixture_longabC'),false);
  assert.equal(exactProfileAlias({words:[...words.slice(0,2),{...words[2],x:5}]},area,'wxid_fixture_longabc'),false);
  assert.equal(exactProfileAlias({words:[...words.slice(0,2),{...words[2],y:80}]},area,'wxid_fixture_longabc'),false);
  assert.equal(exactProfileAlias({words:[...words,{...words[2],text:'extra',line:2,y:60}]},area,'wxid_fixture_longabc'),false);
});

test('private search proof requires an exact labeled contact row and excludes group-member matches',()=>{
  const area=r(80,60,260,140),click=r(80,80,260,120),words=searchWords(area);
  assert.equal(exactPrivateSearchResult({words},area,click,'target_A'),true);
  assert.equal(exactPrivateSearchResult({words:[{...words[0],text:'最常使用'},...words.slice(1)]},area,click,'target_A'),true);
  for(const heading of ['群聊','群成员','聊天记录','联系人（2）'])assert.equal(exactPrivateSearchResult({words:[{...words[0],text:heading},...words.slice(1)]},area,click,'target_A'),false);
  for(const id of ['微信号：target_a','微信号：target_Ax','包含：target_A','target_A','微信号：ｔarget_A'])assert.equal(exactPrivateSearchResult({words:[...words.slice(0,2),{...words[2],text:id}]},area,click,'target_A'),false);
  assert.equal(exactPrivateSearchResult({words:[...words,{...words[2],line:3,y:135}]},area,click,'target_A'),false);
  assert.equal(exactPrivateSearchResult({words:[...words.slice(0,2),{...words[2],confidence:.8}]},area,click,'target_A'),false);
  assert.equal(exactPrivateSearchResult({words},area,r(80,60,260,75),'target_A'),false);
  assert.equal(exactPrivateSearchResult({words},area,r(70,80,260,120),'target_A'),false);
  const invalid=config();invalid.layout.firstResult.left=70;assert.throws(()=>validateQtConfig(invalid),{code:'UI_QT_LAYOUT_INVALID'});
});

test('real-layout tokenization tolerates only a lower-confidence colon and keeps all ID characters exact',()=>{
  const area=r(95,98,470,208),click=r(100,130,350,160),words=[];
  for(const [text,line,y,xStart] of [['最常使用',4,100,106],['Fixture',6,143,162],['微信号：target_A',8,173,162]]){
    let x=xStart;for(const ch of text){words.push({text:ch,line,x,y,width:10,height:20,confidence:ch==='：'?.88745:.99999});x+=11;}
  }
  assert.equal(exactPrivateSearchResult({words},area,click,'target_A'),true);
  const bad=structuredClone(words);bad.find(w=>w.text==='A').confidence=.9;
  assert.equal(exactPrivateSearchResult({words:bad},area,click,'target_A'),false);
});

test('adaptive popup configuration reuses only exact window identity and requires actual main anchors',()=>{
  const c=withObservedPopups(config());assert.equal(validateQtConfig(c).layoutMode,'adaptive-v1');
  assert.deepEqual(Object.keys(toObservedPopupCalibration(popupCalibration(),'profile')),['version','kind','className','ownerRelation','ownerDepth','style','extendedStyle']);
  for(const alter of [v=>delete v.layout.selfOpen,v=>delete v.selfSurface,v=>v.profileCloseKey='click',v=>v.searchPopupCalibration.ownerRelation='same-process',v=>v.profileSurface.popupCalibration.className='',v=>v.selfSurface.alias=r(0,0,10,10),v=>v.layoutMode='automatic']){const bad=structuredClone(c);alter(bad);assert.throws(()=>validateQtConfig(bad));}
  assert.throws(()=>toObservedPopupCalibration({...c.searchPopupCalibration,unexpected:true},'search'));
  const legacy=withPopups(config());legacy.selfSurface.popupCalibration=c.selfSurface.popupCalibration;assert.throws(()=>validateQtConfig(legacy));
});

test('whole observed profiles find one complete labeled ID without old coordinates or nickname matching',()=>{
  const area=r(0,0,700,450),words=[word('Display Name',r(50,30,350,55),0),word('微信号：target_A',r(180,160,600,190),1),word('地区：中国',r(180,210,600,240),2)];
  assert.deepEqual(observedProfileAlias({words},area,'target_A'),r(181,161,599,181));
  for(const changed of [words.map((w,i)=>i===1?{...w,text:'微信号：target_a'}:w),[...words,word('微信号：other',r(150,270,500,300),3)],words.map((w,i)=>i===1?{...w,confidence:.96}:w),words.map((w,i)=>i===1?{...w,text:'target_A'}:w),words.map((w,i)=>i===1?{...w,x:650}:w)])assert.equal(observedProfileAlias({words:changed},area,'target_A'),null);
  const wrapped=[word('昵称',r(10,10,100,35),0),{text:'微信号：wxid_',x:70,y:80,width:250,height:20,line:1,confidence:.99},{text:'fixture_long',x:130,y:105,width:220,height:20,line:2,confidence:.99}];
  assert.ok(observedProfileAlias({words:wrapped},area,'wxid_fixture_long'));
  assert.equal(observedProfileAlias({words:[...wrapped,{...wrapped[2],y:135,line:3,text:'other'}]},area,'wxid_fixture_long'),null);
});

test('observed search infers a click only from the unique complete private row',()=>{
  const area=r(65,95,580,320),words=searchWords(area),proof=observedPrivateSearchResult({words},area,'target_A');
  assert.ok(proof);assert.equal(proof.click.top,121);assert.ok(proof.click.left>=area.left&&proof.click.right<=area.right);
  for(const changed of [[...words,word('更多联系人',r(80,250,450,280),3)],words.map((w,i)=>i===0?{...w,text:'群聊'}:w),words.map((w,i)=>i===2?{...w,text:'微信号：target_Ax'}:w),words.map((w,i)=>i===2?{...w,confidence:.96}:w),words.map((w,i)=>i===1?{...w,y:130}:w)])assert.equal(observedPrivateSearchResult({words:changed},area,'target_A'),null);
  assert.ok(observedPrivateSearchResult({words:words.map((w,i)=>i===2?{...w,confidence:.8}:w)},area,'target_A',false));
  assert.equal(observedPrivateSearchResult({words:words.map((w,i)=>i===2?{...w,text:'微信号：wrong'}:w)},area,'target_A',false),null);
});

const mixedSearchWords=()=>[
  word('最常使用',r(105,100,165,125),0),word('Fixture',r(162,142,220,170),1),word('微信号：target_A',r(162,175,320,199),2),
  word('群聊',r(106,220,135,245),3),word('Fixture group',r(162,265,380,290),4),word('包含：Fixture（微信号：target_A）',r(162,296,430,320),5),
  word('更多',r(105,341,135,365),6),word('网络查找微信号：target_A',r(162,399,440,425),7),
];
test('observed search isolates one exact private section above independently labelled group/network results',()=>{
  const area=r(90,89,490,531),words=mixedSearchWords(),proof=observedPrivateSearchResult({words},area,'target_A');
  assert.ok(proof);assert.equal(proof.click.top,143);assert.equal(proof.area.bottom,196);
  for(const mutate of [
    w=>w[0].text='群聊',w=>w[2].text='微信号：target_B',w=>w[2].confidence=.96,
    w=>w[3].text='Unknown category',w=>w[3].confidence=.96,w=>w[3].x=170,w=>w[3].y=190,
    w=>w.push(word('联系人',r(105,450,180,475),8)),w=>w.splice(3,0,word('Second private name',r(162,201,400,225),9)),
    w=>w[1].text='群成员 Fixture',w=>w[2].text='包含：target_A',
  ]){const changed=structuredClone(words);mutate(changed);assert.equal(observedPrivateSearchResult({words:changed},area,'target_A'),null);}
  const uncertain=structuredClone(words);uncertain[2].confidence=.8;
  assert.ok(observedPrivateSearchResult({words:uncertain},area,'target_A',false));
  uncertain[3].confidence=.8;assert.equal(observedPrivateSearchResult({words:uncertain},area,'target_A',false),null);
});

function fixture(t,amend=()=>{},driverOptions={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-qt-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cfg=config(),frames=path.join(root,'state/ui-host/qt-frames');amend(cfg);fs.mkdirSync(frames,{recursive:true});
  let revision=0,draft='',header='d'.repeat(64),editor='e'.repeat(64),lastRegions=[],aliasExpected='my_alias',actions=[],failAction=null,failCode='QT_PIXELS_CHANGED',failProperties={attempted:false},focusActivation,focusParked=false,foregroundLease,parkedRevision;
  const savedImages=new Map();let textCheckpoint;
  const handoff=()=>({version:1,returnWindow:{hwnd:'200',pid:99,processCreatedFileTimeUtc:'456'},...(focusActivation?{activation:focusActivation}:{}),...(foregroundLease?{foregroundLease}: {})});
  const binding={hwnd:'100',pid:42,threadId:7,processCreatedFileTimeUtc:'12345',dpi:96,foreground:true,clientRect:r(0,0,800,600),captureRect:r(10,10,810,610),focusHwnd:'100',lastInputTick:100};
  const client={async request(action,values={}) {
    actions.push({action,...values});
    if(action===failAction)throw Object.assign(new Error('refused'),{code:failCode,...failProperties});
    if(action==='inspectLayout')return{version:1,readOnly:true,inputSent:false,focusChanged:false,clipboardAccessed:false,executableVersion:cfg.executableVersion,executableSha256:cfg.executableSha256,binding:structuredClone(binding)};
    if(action==='warmUiaLocators')return warmUiaAcknowledgment(values.expectedBinding);
    if(action==='capture'){
      lastRegions=values.regions;
      const result={binding:{...binding},pixelFormat:'rgba-row-major-opaque-v1',token:'1'.repeat(32),epoch:'2'.repeat(32),revision,idleMs:2000,regions:values.regions.map((rect,index)=>({rect,rgbaSha256:JSON.stringify(rect)===JSON.stringify(cfg.layout.editor)?editor:header}))};
      if(values.surface?.startsWith('calibrated-')||values.surface?.startsWith('observed-')){
        const calibration=values.surfaceId==='search'?cfg.searchPopupCalibration:cfg[values.surfaceId+'Surface'].popupCalibration;
        const hwnd=values.surfaceId==='search'?'400':values.surfaceId==='self'?'300':'500';
        result.popup={surfaceId:values.surfaceId,kind:calibration.kind,hwnd,ownerRelation:calibration.ownerRelation,stableObservations:2};
        if(values.surface.startsWith('observed-')){
          const client=calibration.kind==='search'?r(0,0,400,165):r(0,0,440,260),relative=calibration.kind==='search'?r(60,65,460,230):r(25,75,465,335);
          Object.assign(result.popup,{geometryMode:'observed-v1',clientRect:client,clientRectInRoot:relative,windowRect:r(relative.left+10,relative.top+10,relative.right+10,relative.bottom+10),dpi:96});
          if(calibration.kind==='profile')Object.assign(result.binding,{hwnd,clientRect:client});
          if(values.regions.length===0){lastRegions=[calibration.kind==='search'?relative:client];result.regions=lastRegions.map(rect=>({rect,rgbaSha256:header}));}
        }else if(calibration.kind==='profile')Object.assign(result.binding,{hwnd,clientRect:r(0,0,calibration.clientWidth,calibration.clientHeight)});
      }
      if(values.image){const file=path.join(frames,`qt-${crypto.randomBytes(16).toString('hex')}.png`);fs.writeFileSync(file,'fixture');result.image={file,sha256:digest('fixture')};savedImages.set(file,{area:lastRegions[0],alias:aliasExpected,surface:values.surfaceId,width:result.binding.clientRect.right,height:result.binding.clientRect.bottom,header,editor});}
      return result;
    }
    if(action==='readDraft'){const result={draft,draftVerified:true,clipboardRestored:true,emptyTemplateMatched:draft==='',revision};if(draft&&values.headerRect){assert.deepEqual(lastRegions,[values.headerRect]);assert.deepEqual(values.editorRect,cfg.layout.editor);result.postPasteFrame=await client.request('capture',{regions:[values.headerRect,values.editorRect],surface:'main',image:false});result.textEnterProof={version:1,id:'b'.repeat(32),textSha256:digest(draft.replace(/\r\n/g,'\n').replace(/\r/g,'\n'))};textCheckpoint={...result.textEnterProof,stepBinding:values.stepBinding};}return result;}
    if(action==='movePointer')return{performed:true,attempted:true,revision,pointerParked:true,focusPreserved:true};
    if(action==='typeText'){
      assert.equal(values.expectedText,draft+values.text);assert.equal(values.textEnterProofId,draft?textCheckpoint?.id:undefined);draft+=values.text;editor='f'.repeat(64);
      const postPasteFrame=await client.request('capture',{regions:[values.headerRect,values.editorRect],surface:'main',image:false}),textEnterProof={version:1,id:'b'.repeat(32),textSha256:digest(draft)};
      textCheckpoint={...textEnterProof,stepBinding:values.stepBinding};return{performed:true,attempted:true,revision,typeApplied:true,readbackPerformed:false,intendedText:draft,clipboardAccessed:false,interrupted:false,postPasteFrame,textEnterProof};
    }
    if(action==='paste'){if(values.scope==='editor'){draft+=values.text;editor='f'.repeat(64);}const result={performed:true,attempted:true,revision,clipboardRestored:true,...(values.readback===false?{pasteApplied:true,readbackPerformed:false,intendedText:values.expectedText,interrupted:false}:{pasteVerified:true,draft:values.expectedText,...(values.replaceSearch===true?{searchReplaced:true}:{})})};
      if(values.scope==='search'&&cfg.layoutMode==='adaptive-v1'){result.postPasteFrame=await client.request('capture',{regions:[cfg.layout.search],surface:'observed-search',surfaceId:'search',image:false});result.searchEnterProof={version:1,id:'a'.repeat(32),querySha256:digest(values.expectedText)};}
      if(values.scope==='editor'&&values.headerRect){result.postPasteFrame=await client.request('capture',{regions:[values.headerRect,values.editorRect],surface:'main',image:false});result.textEnterProof={version:1,id:'b'.repeat(32),textSha256:digest(values.expectedText)};textCheckpoint={...result.textEnterProof,stepBinding:values.stepBinding};}return result;}
    if(action==='resumeTextEnterProof'){
      assert.ok(textCheckpoint);assert.equal(values.textEnterProofId,textCheckpoint.id);assert.equal(values.textSha256,textCheckpoint.textSha256);assert.deepEqual(values.stepBinding,textCheckpoint.stepBinding);assert.deepEqual(lastRegions,[cfg.layout.header,cfg.layout.editor]);
      const postPasteFrame=await client.request('capture',{regions:[values.headerRect,values.editorRect],surface:'main',image:false}),textEnterProof={version:1,id:'c'.repeat(32),textSha256:values.textSha256};textCheckpoint={...textEnterProof,stepBinding:values.stepBinding};return{performed:true,attempted:true,resumed:true,revision,postPasteFrame,textEnterProof};
    }
    if(action==='searchEnter'){header='9'.repeat(64);Object.assign(binding,{focusBelongsToWindow:true,caretHwnd:'100',caretBelongsToWindow:true,guiFlags:1,caretRectInClient:r(320,470,322,472)});return{performed:true,attempted:true,revision,searchAccepted:true};}
    if(action==='submitTextEnter')return{performed:true,attempted:true,revision,submittedViaEnter:true};
    if(action==='beginFocusHandoff'){focusActivation=values.focusActivation;foregroundLease={version:1,startedAtTickMs:100,includesContactNavigation:values.includesContactNavigation===true};return{activated:true,focusHandoff:handoff()};}
    if(action==='parkFocusHandoff'){focusParked=true;parkedRevision=revision;return{parked:true,restored:true,skipped:false,foregroundInterval:{phase:foregroundLease?.includesContactNavigation?'contact-navigation':'preparation',durationMs:100,includesContactNavigation:foregroundLease?.includesContactNavigation===true,complete:true}};}
    if(action==='resumeFocusHandoff'){if(parkedRevision!==revision)throw Object.assign(Error('activity'),{code:'QT_HUMAN_ACTIVITY_CHANGED',attempted:false});focusParked=false;foregroundLease={version:1,startedAtTickMs:200,includesContactNavigation:values.includesContactNavigation===true};return{resumed:true,focusHandoff:handoff()};}
    if(action==='inspectFocusHandoff')return{ready:true,reason:null,inputSent:false,clipboardAccessed:false,focusChanged:false};
    if(action==='transferFocusHandoff')return{transferred:true,revision,focusHandoff:handoff(),cleanup:{version:1,returnWindow:{hwnd:'200',pid:99,processCreatedFileTimeUtc:'456'},wechatWindow:{hwnd:'100',pid:42,processCreatedFileTimeUtc:'12345'},lastInputTick:100,issuedAtMs:Date.now()}};
    if(action==='restoreTransferredFocus'||action==='releaseFocusHandoff')return{restored:true,skipped:false,...(!focusParked?{foregroundInterval:{phase:foregroundLease?.includesContactNavigation?'contact-navigation':'preparation',durationMs:100,includesContactNavigation:foregroundLease?.includesContactNavigation===true,complete:true}}:{})};
    if(action==='click'&&JSON.stringify(values.rect)===JSON.stringify(cfg.layout.profileOpen))aliasExpected='target_A';
    if(action==='click'&&JSON.stringify(values.rect)===JSON.stringify(cfg.layout.selfOpen))aliasExpected='my_alias';
    if(action==='type'&&values.text==='好'){draft+='好';editor='f'.repeat(64);}
    return{performed:true,attempted:true,revision};
  },close(){},async release(){actions.push({action:'release'});return{processStopped:true};}};
  const driver=new QtVisualDriver({root,config:cfg,client,clientFactory:()=>client,allowSubmit:true,receipt:async()=>({confirmed:false}),wait:async()=>{},resolveTarget:async job=>({wechatId:job.target,alias:'target_A',ambiguous:false}),...driverOptions,
    probeAccount:async()=>({accountRef:cfg.accountRef,accountScopeHash:cfg.accountRef,evidence:{ok:true,proof:'process-open-database-v1',complete:true,processOpenedExpectedDatabase:true,processId:42,processCreatedFileTimeUtc:'12345',observedAtUtc:new Date(driver.now()).toISOString(),maximumEvidenceAgeMs:500,snapshotAtomic:false,accountRootsObserved:1,consistentPathScans:2,expectedDatabaseHandles:1,ready:false,desktopAccountVerified:false,targetVerified:false,draftVerified:false,inputSent:false}}),
    verifyPanelClosed:async({imageSha256,width,height,dpi})=>({version:1,closed:true,readOnly:true,inputSent:false,imageSha256,width,height,dpi}),
    locateMainTitle:async({imageSha256,width,height,dpi})=>({version:1,readOnly:true,inputSent:false,identityVerified:false,emptyDraftAuthorized:false,imageSha256,width,height,dpi,headerRect:cfg.layout.header,titleRect:cfg.layout.profileOpen,headerRgbaSha256:header,titleRgbaSha256:header}),
    inspectPanelEditor:async({file,imageSha256,width,height,dpi})=>{const saved=savedImages.get(file);return{version:1,readOnly:true,inputSent:false,identityVerified:false,emptyDraftAuthorized:false,imageSha256,width,height,dpi,headerRgbaSha256:saved.header,editorRgbaSha256:saved.editor,canonicalEditorSha256:saved.editor,caretCandidate:false};},
    locateSearchPopup:async({imageSha256,width,height,dpi,popup})=>({version:1,ok:true,readOnly:true,inputSent:false,identityVerified:false,imageSha256,width,height,dpi,popupRect:popup,contentRect:popup,popupRgbaSha256:header}),
    verifyContact:async()=>({matched:true,unique:true,comparison:'exact'}),recognize:async({file,preprocess,region,model='small'})=>{const saved=savedImages.get(file);return{imageSha256:digest('fixture'),width:saved.width,height:saved.height,model:`PP-OCRv6-${model}`,...(region?{region}:{}),...(preprocess?{preprocess}:{}),words:saved.surface==='search'||JSON.stringify(saved.area)===JSON.stringify(cfg.layout.searchResultIdentity)?searchWords(saved.area):[word('微信号：'+saved.alias,saved.area)]};}});
  return {driver,actions,job:{id:'3'.repeat(64),account:cfg.account,target:'wxid_target',text:'好',index:0},setRevision:n=>revision=n,setDraft:t=>draft=t,setHeader:h=>header=h,setEditor:h=>editor=h,setFailure:(action,code='QT_PIXELS_CHANGED',properties={attempted:false})=>{failAction=action;failCode=code;failProperties=properties;}};
}

const panelProof=({imageSha256,width,height,dpi})=>({version:1,imageSha256,width,height,dpi,memberRect:r(620,100,680,160),panelRect:r(580,70,795,440),closeRect:r(400,25,500,50),closeRole:'header-title-toggle',panelRgbaSha256:'d'.repeat(64),memberRgbaSha256:'d'.repeat(64),closeRgbaSha256:'d'.repeat(64)});

async function titleFixture(t){
  const f=fixture(t,withObservedPopups),initial=await f.driver.capture(['header']);
  f.driver.transaction={epoch:initial.epoch,revision:initial.revision,pid:initial.binding.pid,created:initial.binding.processCreatedFileTimeUtc};
  f.actions.length=0;return f;
}
test('current shorter contact title replaces only the observed click rectangle and consumes its exact fresh token',async t=>{
  const f=await titleFixture(t),original=f.driver.locateMainTitle,old=structuredClone(f.driver.config.layout.profileOpen),short=r(400,25,430,50);
  f.driver.locateMainTitle=async input=>({...await original(input),titleRect:short});
  const proof=await f.driver.observeCurrentMainTitle();assert.deepEqual(proof.titleRect,short);assert.deepEqual(f.driver.config.layout.profileOpen,old);
  assert.equal(f.actions.some(a=>a.action==='click'),false);await f.driver.clickCurrentMainTitle(proof);
  const click=f.actions.at(-1);assert.equal(click.action,'click');assert.deepEqual(click.rect,short);assert.equal(click.token,'1'.repeat(32));
  assert.deepEqual(f.actions.at(-2).regions,[proof.headerRect,short]);assert.deepEqual(f.driver.config.layout.profileOpen,old);
});
test('current title source, geometry, permissions, complete header and glyph pixels must all remain bound',async t=>{
  for(const failure of ['source','width','dpi','header-rect','outside','header-hash','title-hash','readonly','identity','draft','extra','changed-header']){
    const f=await titleFixture(t),original=f.driver.locateMainTitle;
    f.driver.locateMainTitle=async input=>{const proof=await original(input);
      if(failure==='source')proof.imageSha256='0'.repeat(64);if(failure==='width')proof.width++;if(failure==='dpi')proof.dpi++;
      if(failure==='header-rect')proof.headerRect={...proof.headerRect,left:proof.headerRect.left+1};if(failure==='outside')proof.titleRect=r(0,0,10,10);
      if(failure==='header-hash')proof.headerRgbaSha256='0'.repeat(64);if(failure==='title-hash')proof.titleRgbaSha256='0'.repeat(64);
      if(failure==='readonly')proof.readOnly=false;if(failure==='identity')proof.identityVerified=true;if(failure==='draft')proof.emptyDraftAuthorized=true;if(failure==='extra')proof.extra=true;
      if(failure==='changed-header')f.setHeader('a'.repeat(64));return proof;};
    await assert.rejects(f.driver.observeCurrentMainTitle(),{code:['title-hash','changed-header'].includes(failure)?'UI_QT_MAIN_TITLE_CHANGED':'UI_QT_MAIN_TITLE_UNVERIFIED'});
    assert.equal(f.actions.some(a=>a.action==='click'),false);
  }
  const f=await titleFixture(t),proof=await f.driver.observeCurrentMainTitle();f.setHeader('a'.repeat(64));
  await assert.rejects(f.driver.clickCurrentMainTitle(proof),{code:'UI_QT_MAIN_TITLE_CHANGED'});assert.equal(f.actions.some(a=>a.action==='click'),false);
});
test('current title observation keeps original activity transaction and does not click on failure',async t=>{
  const f=await titleFixture(t),original=f.driver.locateMainTitle;
  f.driver.locateMainTitle=async input=>{const proof=await original(input);f.setRevision(1);return proof;};
  await assert.rejects(f.driver.observeCurrentMainTitle(),{code:'UI_QT_HUMAN_ACTIVITY_CHANGED'});assert.equal(f.actions.some(a=>a.action==='click'),false);
});
test('opened panel close control must match the newly observed title, not an old wider calibrated title',async t=>{
  for(const kind of ['rect','pixels']){
    const f=fixture(t,withObservedPopups);f.driver.locateContactPanel=async input=>{const proof=panelProof(input);if(kind==='rect')proof.closeRect={...proof.closeRect,right:proof.closeRect.right-10};else proof.closeRgbaSha256='0'.repeat(64);return proof;};
    await assert.rejects(f.driver.prepare(f.job),{code:'UI_QT_CONTACT_PANEL_UNVERIFIED'});
    assert.equal(f.actions.some(a=>a.action==='click'&&JSON.stringify(a.rect)===JSON.stringify(r(620,100,680,160))),false);
  }
});

async function profileReadinessFixture(t,surface='self'){
  const f=await titleFixture(t),mainBaseline=await f.driver.capture(['header']);f.driver.voiceFocusLease={parked:false};f.driver.surface=surface;
  const source=await f.driver.capture([]);f.actions.length=0;return{...f,mainBaseline,source};
}
test('profile reopen waits only for the exact original complete pixels and locks its new causal popup HWND',async t=>{
  const f=await profileReadinessFixture(t),request=f.driver.client.request,phases=['a','b','d'];let reads=0;const waits=[];
  f.driver.wait=async ms=>waits.push(ms);f.driver.client.request=async(action,input)=>{const result=await request(action,input);if(action==='capture'){
    result.binding.hwnd=result.popup.hwnd='777';result.regions[0].rgbaSha256=phases[reads++].repeat(64);result.token=reads.toString(16).padStart(32,'0');
  }return result;};
  const current=await f.driver.waitForExactProfileSource(f.source);assert.equal(current.popup.hwnd,'777');assert.equal(current.regions[0].rgbaSha256,f.source.regions[0].rgbaSha256);assert.equal(reads,3);assert.deepEqual(waits,[35,35]);
  assert.equal(f.actions.every(a=>a.action==='capture'&&a.surface==='observed-profile'&&a.image===false&&a.regions.length===0),true);assert.equal(f.driver.frame,current);
});
test('profile exact readiness never accepts changed original geometry identity transaction or a second reopened HWND',async t=>{
  for(const kind of ['thread','pid','creation','dpi','capture','relative','window','client','owner','region','epoch','revision','hwnd']){
    const f=await profileReadinessFixture(t),request=f.driver.client.request;let reads=0;
    f.driver.client.request=async(action,input)=>{const result=await request(action,input);if(action==='capture'){
      reads++;if(kind==='hwnd'&&reads===1)result.regions[0].rgbaSha256='a'.repeat(64);
      if(kind==='thread')result.binding.threadId=99;if(kind==='pid')result.binding.pid++;if(kind==='creation')result.binding.processCreatedFileTimeUtc='54321';if(kind==='dpi')result.binding.dpi=144;
      if(kind==='capture')result.binding.captureRect={...result.binding.captureRect,left:result.binding.captureRect.left+1};
      if(kind==='relative'){result.popup.clientRectInRoot.left++;result.popup.clientRectInRoot.right++;}if(kind==='window'){result.popup.windowRect.left++;result.popup.windowRect.right++;}
      if(kind==='client')result.binding.clientRect={...result.binding.clientRect,bottom:result.binding.clientRect.bottom+1};if(kind==='owner')result.popup.ownerRelation='root-owned';if(kind==='region')result.regions[0].rect={...result.regions[0].rect,left:1};
      if(kind==='epoch')result.epoch='f'.repeat(32);if(kind==='revision')result.revision++;if(kind==='hwnd'&&reads===2)result.binding.hwnd=result.popup.hwnd='777';
    }return result;};
    await assert.rejects(f.driver.waitForExactProfileSource(f.source),undefined,kind);assert.equal(reads,kind==='hwnd'?2:1,kind);assert.equal(f.actions.some(a=>a.action==='chord'||a.action==='click'),false);
  }
});
test('profile readiness retries only explicit read-only full-popup pixels and retains its original time budget',async t=>{
  for(const kind of ['retry','attempted','unknown','guard','wrong-anchor','geometry','focus','obscured']){
    const f=await profileReadinessFixture(t),request=f.driver.client.request;let reads=0;
    f.driver.client.request=async(action,input)=>{if(action==='capture'&&++reads===1){const error=Object.assign(Error('read refused'),{code:'QT_PIXELS_CHANGED',attempted:false,pixelMismatch:{stage:'capture',anchorIndex:0}});
      if(kind==='attempted')error.attempted=true;if(kind==='unknown')delete error.attempted;if(kind==='guard')error.pixelMismatch.stage='guard';if(kind==='wrong-anchor')error.pixelMismatch.anchorIndex=1;
      if(kind==='geometry')error.code='QT_POPUP_BINDING_CHANGED';if(kind==='focus')error.code='DRAFT_WINDOW_NOT_FOREGROUND';if(kind==='obscured')error.code='QT_WINDOW_OBSCURED';throw error;
    }return request(action,input);};
    if(kind==='retry'){await f.driver.waitForExactProfileSource(f.source);assert.equal(reads,2);}else{await assert.rejects(f.driver.waitForExactProfileSource(f.source));assert.equal(reads,1);}
  }
  const f=await profileReadinessFixture(t),request=f.driver.client.request;let tick=0,reads=0;
  f.driver.now=()=>tick;f.driver.wait=async ms=>{tick+=ms;};f.driver.client.request=async(action,input)=>{const result=await request(action,input);if(action==='capture'){reads++;tick+=40;result.regions[0].rgbaSha256='a'.repeat(64);}return result;};
  await assert.rejects(f.driver.waitForExactProfileSource(f.source),{code:'UI_QT_PROFILE_CHANGED'});assert.ok(reads<=6);assert.ok(tick<=440);assert.equal(f.actions.every(a=>a.action==='capture'),true);
});
test('verified profile close consumes exactly the matching final capture token without an intervening capture',async t=>{
  for(const surface of ['self','profile']){
    const f=await profileReadinessFixture(t,surface),frame=await f.driver.waitForExactProfileSource(f.source);f.actions.length=0;
    if(surface==='self')await f.driver.closeObservedSelfProfile(f.mainBaseline,frame);else await f.driver.closeVerifiedProfile(frame);
    assert.equal(f.actions[0].action,'chord');assert.equal(f.actions[0].key,'Escape');assert.equal(f.actions[0].token,frame.token);assert.equal(f.actions.filter(a=>a.action==='chord').length,1);
    assert.equal(f.actions.some(a=>a.action==='capture'&&a.surface==='observed-profile'),false);
    f.driver.surface=surface;f.driver.frame=frame;const count=f.actions.length;
    await assert.rejects(surface==='self'?f.driver.closeObservedSelfProfile(f.mainBaseline,frame):f.driver.closeVerifiedProfile(frame),{code:'UI_QT_OBSERVATION_INVALID'});assert.equal(f.actions.length,count);
  }
});
test('one-time profile close proof rejects any replacement frame mutation surface or focus lease',async t=>{
  for(const kind of ['capture','clone','token','pixels','geometry','lease','parked','surface','epoch','close-key']){
    const f=await profileReadinessFixture(t),frame=await f.driver.waitForExactProfileSource(f.source);
    if(kind==='capture')await f.driver.capture([]);if(kind==='clone')f.driver.frame=structuredClone(frame);if(kind==='token')frame.token='a'.repeat(32);if(kind==='pixels')frame.regions[0].rgbaSha256='a'.repeat(64);if(kind==='geometry')frame.popup.windowRect.left++;
    if(kind==='lease')f.driver.voiceFocusLease={parked:false};if(kind==='parked')f.driver.voiceFocusLease.parked=true;if(kind==='surface')f.driver.surface='profile';if(kind==='epoch')frame.epoch='a'.repeat(32);if(kind==='close-key')f.driver.config.selfCloseKey='click';
    const before=f.actions.length;await assert.rejects(f.driver.closeObservedSelfProfile(f.mainBaseline,frame));assert.equal(f.actions.length,before,kind);
  }
});


async function panelClosedFixture(t){
  const f=await titleFixture(t),baseline=await f.driver.capture(['header','editor'],true);f.actions.length=0;
  return {...f,baseline};
}
async function closeReadinessFixture(t,kind){
  const f=await panelClosedFixture(t),title=await f.driver.observeCurrentMainTitle(),panel=panelProof({imageSha256:'a'.repeat(64),width:800,height:600,dpi:96});
  f.driver.voiceFocusLease={parked:false};f.driver.config.settleMs=250;f.actions.length=0;const waits=[];f.driver.wait=async ms=>waits.push(ms);
  return {...f,title,panel,waits,close:()=>kind==='title'?f.driver.clickCurrentMainTitle(title,{closedBaseline:f.baseline}):f.driver.clickObservedPanel(panel,'close',{closedBaseline:f.baseline})};
}
test('only explicit shared panel closes replace fixed settle with the original full closed-frame and canonical verification',async t=>{
  for(const kind of ['title','panel']){
    const f=await closeReadinessFixture(t,kind);let checks=0,images=0;const verify=f.driver.verifyPanelClosed,inspect=f.driver.inspectPanelEditor;
    f.driver.verifyPanelClosed=async input=>{checks++;return verify(input);};f.driver.inspectPanelEditor=async input=>{images++;return inspect(input);};
    const closed=await f.close();assert.deepEqual(f.waits,[35]);assert.equal(f.actions.filter(a=>a.action==='click').length,1);assert.equal(fs.existsSync(closed.image.file),true);
    assert.equal(f.driver.current,null);await f.driver.verifyObservedPanelClosed(f.baseline,{captured:closed,park:false});assert.equal(checks,1);assert.equal(images,2);assert.equal(fs.existsSync(closed.image.file),false);
    assert.equal(f.driver.panelClosedFrameMatches(f.baseline,await f.driver.capture(['header','editor'])),true);
    const ordinary=await closeReadinessFixture(t,kind);if(kind==='title')await ordinary.driver.clickCurrentMainTitle(ordinary.title);else await ordinary.driver.clickObservedPanel(ordinary.panel,'close');assert.deepEqual(ordinary.waits,[250]);
    if(kind==='panel'){ordinary.waits.length=0;await ordinary.driver.clickObservedPanel(ordinary.panel,'member',{transition:true});assert.deepEqual(ordinary.waits,[250]);}
  }
});
test('a closed-panel shortcut refuses invalid baseline authority before any click',async t=>{
  for(const kind of ['title','panel'])for(const invalid of ['nonshared','parked','surface','epoch','header','missing-image','wrong-image-hash','outside-image','geometry','member','transition']){
    const f=await closeReadinessFixture(t,kind);
    if(invalid==='nonshared')f.driver.voiceFocusLease=null;if(invalid==='parked')f.driver.voiceFocusLease.parked=true;if(invalid==='surface')f.driver.surface='search';
    if(invalid==='epoch')f.baseline.epoch='f'.repeat(32);if(invalid==='header')f.baseline.regions[0].rect=r(0,0,1,1);
    if(invalid==='missing-image')delete f.baseline.image;if(invalid==='wrong-image-hash')f.baseline.image.sha256='0'.repeat(64);if(invalid==='outside-image')f.baseline.image.file=path.join(f.driver.root,'outside.png');
    if(invalid==='geometry')f.baseline.binding.captureRect={...f.baseline.binding.captureRect,left:11};
    if(kind==='title'&&['member','transition'].includes(invalid))continue;
    const action=invalid==='member'?()=>f.driver.clickObservedPanel(f.panel,'member',{closedBaseline:f.baseline}):invalid==='transition'?()=>f.driver.clickObservedPanel(f.panel,'close',{transition:true,closedBaseline:f.baseline}):f.close;
    await assert.rejects(action(),undefined,kind+invalid);assert.equal(f.actions.some(a=>a.action==='click'),false,kind+invalid);
  }
});
test('unchanged animation pixels do not bypass the full editor canonical proof and close failures never repeat a click',async t=>{
  for(const kind of ['title','panel']){
    const f=await closeReadinessFixture(t,kind);f.setEditor('a'.repeat(64));const closed=await f.close();
    await assert.rejects(f.driver.verifyObservedPanelClosed(f.baseline,{captured:closed,park:false}),{code:'UI_QT_CONTACT_PANEL_CLOSE_UNVERIFIED'});
    assert.equal(f.actions.filter(a=>a.action==='click').length,1);assert.equal(fs.existsSync(closed.image.file),false);assert.equal(f.driver.panelEditorProofs?.get(f.baseline),undefined);
    const failed=await closeReadinessFixture(t,kind);failed.setFailure('click','QT_INPUT_UNCERTAIN',{attempted:true});await assert.rejects(failed.close(),{code:'QT_INPUT_UNCERTAIN'});assert.equal(failed.actions.filter(a=>a.action==='click').length,1);
  }
});

async function searchReadinessFixture(t){
  const f=await titleFixture(t),baseline=await f.driver.capture(['header']);
  f.driver.voiceFocusLease={parked:false};f.driver.surface='search';await f.driver.capture([]);f.actions.length=0;
  return{...f,baseline};
}
async function searchQueryClickFixture(t){
  const f=await searchReadinessFixture(t),request=f.driver.client.request;let tick=0,captures=0;
  f.driver.config.settleMs=250;f.driver.now=()=>tick;f.driver.wait=async ms=>{tick+=ms;};
  f.driver.client.request=async(action,input)=>{const frame=await request(action,input);if(action==='capture'&&input.surface==='observed-search'){
    captures++;frame.token=captures.toString(16).padStart(32,'0');Object.assign(frame.binding,{threadId:7,focusHwnd:frame.binding.hwnd,caretHwnd:frame.binding.hwnd,focusBelongsToWindow:true,caretBelongsToWindow:true,guiFlags:1,caretRectInClient:r(100,30,102,32)});
  }return frame;};
  return {...f,elapsed:()=>tick,advance:ms=>{tick+=ms;},captures:()=>captures,click:()=>f.driver.action('click',{rect:f.driver.config.layout.search},['search'],{settleSearchQuery:true})};
}
test('query click can finish its settle after two complete matching caret observations but paste still obtains a new native token',async t=>{
  const f=await searchQueryClickFixture(t);await f.click();assert.equal(f.elapsed(),35);assert.equal(f.captures(),3);assert.equal(f.actions.filter(a=>a.action==='click').length,1);
  const readinessToken=f.driver.frame.token;
  await f.driver.action('paste',{text:'target_A',expectedText:'target_A',scope:'search',replaceSearch:true},['search']);
  const paste=f.actions.find(a=>a.action==='paste');assert.ok(paste);assert.notEqual(paste.token,readinessToken);assert.equal(f.captures(),5);assert.equal(f.actions.filter(a=>a.action==='paste').length,1);
});
test('query caret shortcut requires complete root-owned focus metadata and never borrows missing proof from elapsed time',async t=>{
  for(const kind of ['missing','zero','flags','focus-owner-missing','caret-owner','caret-child','outside-query','below-popup','thread-missing','hash-changing','caret-changing']){
    const f=await searchQueryClickFixture(t),request=f.driver.client.request;let observations=0,clicked=false;
    f.driver.client.request=async(action,input)=>{if(action==='click')clicked=true;const frame=await request(action,input);if(action==='capture'){
      if(kind==='thread-missing')delete frame.binding.threadId;
      if(clicked){observations++;const b=frame.binding;
        if(kind==='missing')delete b.caretRectInClient;if(kind==='zero')b.caretRectInClient=r(0,0,0,0);if(kind==='flags')b.guiFlags=0;
        if(kind==='focus-owner-missing')delete b.focusBelongsToWindow;if(kind==='caret-owner')b.caretBelongsToWindow=false;
        if(kind==='caret-child')b.caretHwnd='101';
        if(kind==='outside-query')b.caretRectInClient=r(1,30,3,32);if(kind==='below-popup')b.caretRectInClient=r(100,64,102,66);
        if(kind==='hash-changing')frame.regions[0].rgbaSha256=(observations%2?'a':'b').repeat(64);
        if(kind==='caret-changing')b.caretRectInClient=r(100+observations%2,30,102+observations%2,32);
      }
    }return frame;};
    await f.click();assert.equal(f.elapsed(),250,kind);assert.ok(observations<=8,kind);assert.equal(f.actions.filter(a=>a.action==='click').length,1,kind);assert.equal(f.actions.some(a=>a.action==='paste'),false);
  }
});
test('query observations retain exact original root popup activity and anchor bindings and never retry an input failure',async t=>{
  for(const kind of ['root','thread','epoch','revision','dpi','root-geometry','popup-hwnd','popup-height','popup-owner','popup-position','anchor','active','focus-changed','focus-owner','focus-error','obscured','input-error']){
    const f=await searchQueryClickFixture(t),request=f.driver.client.request;let clicked=false,reads=0;
    f.driver.client.request=async(action,input)=>{
      if(action==='click'){clicked=true;if(kind==='input-error')throw Object.assign(Error('input uncertain'),{code:'QT_INPUT_UNCERTAIN',attempted:true});}
      if(clicked&&action==='capture'){
        reads++;if(kind==='focus-error'||kind==='obscured')throw Object.assign(Error('guard'),{code:kind==='focus-error'?'QT_POPUP_FOCUS_CHANGED':'QT_WINDOW_OBSCURED',attempted:false});
      }
      const frame=await request(action,input);if(clicked&&action==='capture'){
        if(kind==='root')frame.binding.hwnd='101';if(kind==='thread')frame.binding.threadId=8;if(kind==='epoch')frame.epoch='f'.repeat(32);if(kind==='revision')frame.revision++;
        if(kind==='dpi')frame.binding.dpi=120;if(kind==='root-geometry')frame.binding.captureRect={...frame.binding.captureRect,right:frame.binding.captureRect.right+1};
        if(kind==='popup-hwnd')frame.popup.hwnd='999';if(kind==='popup-height')searchHeight(frame,200);if(kind==='popup-owner')frame.popup.ownerRelation='root-owned';
        if(kind==='popup-position'){frame.popup.windowRect.left++;frame.popup.windowRect.right++;}if(kind==='anchor')frame.regions[0].rect={...frame.regions[0].rect,left:81};if(kind==='active')frame.idleMs=0;
        if(kind==='focus-changed')frame.binding.focusHwnd='101';if(kind==='focus-owner')frame.binding.focusBelongsToWindow=false;
      }return frame;
    };
    await assert.rejects(f.click(),undefined,kind);assert.equal(reads,kind==='input-error'?0:1,kind);assert.equal(f.actions.some(a=>a.action==='paste'),false);
    assert.ok(f.actions.filter(a=>a.action==='click').length<=1,kind);
  }
});
test('query read-only pixel recovery restarts its two-frame proof inside the same original settle budget',async t=>{
  for(const kind of ['retry','attempted','unknown','guard','anchor']){
    const f=await searchQueryClickFixture(t),request=f.driver.client.request;let clicked=false,reads=0;
    f.driver.client.request=async(action,input)=>{if(action==='click')clicked=true;if(clicked&&action==='capture'&&++reads===2){
      const failure={code:'QT_PIXELS_CHANGED',attempted:false,pixelMismatch:{stage:'capture',anchorIndex:0}};
      if(kind==='attempted')failure.attempted=true;if(kind==='unknown')delete failure.attempted;if(kind==='guard')failure.pixelMismatch.stage='guard';if(kind==='anchor')failure.pixelMismatch.anchorIndex=1;throw Object.assign(Error('pixels'),failure);
    }return request(action,input);};
    if(kind==='retry'){await f.click();assert.equal(reads,4);assert.equal(f.elapsed(),105);}else{await assert.rejects(f.click());assert.equal(reads,2);}
    assert.equal(f.actions.filter(a=>a.action==='click').length,1);assert.equal(f.actions.some(a=>a.action==='paste'),false);
  }
});
test('query observation capture time counts against its allowance and unsupported caret retains nondefault original settles',async t=>{
  for(const settle of [120,250,400]){
    const f=await searchQueryClickFixture(t),request=f.driver.client.request;f.driver.config.settleMs=settle;let clicked=false;
    f.driver.client.request=async(action,input)=>{if(action==='click')clicked=true;const frame=await request(action,input);if(clicked&&action==='capture'){f.advance(10);delete frame.binding.caretRectInClient;}return frame;};
    await f.click();assert.equal(f.elapsed(),settle);assert.equal(f.actions.filter(a=>a.action==='click').length,1);
  }
  const slow=await searchQueryClickFixture(t),request=slow.driver.client.request;let clicked=false,reads=0;
  slow.driver.client.request=async(action,input)=>{if(action==='click')clicked=true;const frame=await request(action,input);if(clicked&&action==='capture'){reads++;slow.advance(260);}return frame;};
  await slow.click();assert.equal(reads,1);assert.equal(slow.elapsed(),260);assert.equal(slow.actions.filter(a=>a.action==='click').length,1);
  const forbidden=await searchQueryClickFixture(t);forbidden.driver.voiceFocusLease=null;
  await assert.rejects(forbidden.click(),{code:'UI_QT_OBSERVATION_INVALID'});assert.equal(forbidden.actions.some(a=>a.action==='click'),false);
});
test('search readiness requires complete popup pixels quiet for 125 ms with reads at least 35 ms apart and no input',async t=>{
  const f=await searchReadinessFixture(t),request=f.driver.client.request,phases=['a','b','d','d'];let tick=0,reads=0;const waits=[];
  f.driver.now=()=>tick;f.driver.wait=async ms=>{waits.push(ms);tick+=ms;};
  f.driver.client.request=async(action,input)=>{const result=await request(action,input);if(action==='capture'){result.regions[0].rgbaSha256=phases[Math.min(reads++,phases.length-1)].repeat(64);tick+=15;}return result;};
  const result=await f.driver.waitForStableSearchResults(f.baseline);
  assert.equal(result.regions[0].rgbaSha256,'d'.repeat(64));assert.equal(reads,6);assert.deepEqual(waits,[35,35,35,35,35]);
  assert.equal(f.actions.every(a=>a.action==='capture'&&a.surface==='observed-search'&&a.regions.length===0&&a.image===false),true);
});
test('search readiness never rebinds popup identity geometry or original activity transaction',async t=>{
  for(const kind of ['hwnd','root-hwnd','thread','epoch','revision','dpi','position','width','height','owner','region']){
    const f=await searchReadinessFixture(t),request=f.driver.client.request;let reads=0;
    f.driver.client.request=async(action,input)=>{const result=await request(action,input);if(action==='capture'&&++reads===2){
      if(kind==='hwnd')result.popup.hwnd='999';if(kind==='root-hwnd')result.binding.hwnd='101';if(kind==='thread')result.binding.threadId=99;
      if(kind==='epoch')result.epoch='f'.repeat(32);if(kind==='revision')result.revision++;
      if(kind==='dpi')result.popup.dpi=144;if(kind==='position'){result.popup.windowRect.left++;result.popup.windowRect.right++;}
      if(kind==='width'){result.popup.clientRect.right++;result.popup.clientRectInRoot.right++;}
      if(kind==='height'){result.popup.clientRect.bottom++;result.popup.clientRectInRoot.bottom++;result.regions[0].rect.bottom++;}
      if(kind==='owner')result.popup.ownerRelation='root-owned';if(kind==='region')result.regions[0].rect.left++;
    }return result;};
    await assert.rejects(f.driver.waitForStableSearchResults(f.baseline),undefined,kind);assert.equal(reads,2);assert.equal(f.actions.some(a=>a.action==='paste'||a.action==='click'||a.action==='chord'),false);
  }
});
test('search readiness only retries an unattempted full-popup capture mismatch, never ambiguous popup or input failures',async t=>{
  for(const kind of ['retry','attempted','guard','wrong-anchor','missing-attempted','zero-popup','multiple-popup','focus','clipboard']){
    const f=await searchReadinessFixture(t),request=f.driver.client.request;let reads=0;
    f.driver.client.request=async(action,input)=>{if(action==='capture'&&++reads===1){const error={code:'QT_PIXELS_CHANGED',attempted:false,pixelMismatch:{stage:'capture',anchorIndex:0}};
      if(kind==='attempted')error.attempted=true;if(kind==='missing-attempted')delete error.attempted;if(kind==='guard')error.pixelMismatch.stage='guard';if(kind==='wrong-anchor')error.pixelMismatch.anchorIndex=1;
      if(kind==='zero-popup'||kind==='multiple-popup')error.code='QT_POPUP_CANDIDATE_NOT_UNIQUE';if(kind==='focus')error.code='QT_POPUP_FOCUS_CHANGED';if(kind==='clipboard')error.code='DRAFT_CLIPBOARD_CHANGED';
      throw Object.assign(Error('failure'),error);
    }return request(action,input);};
    if(kind==='retry'){await f.driver.waitForStableSearchResults(f.baseline);assert.equal(reads,6);}else{await assert.rejects(f.driver.waitForStableSearchResults(f.baseline));assert.equal(reads,1);}
    assert.equal(f.actions.some(a=>a.action==='paste'||a.action==='click'||a.action==='chord'),false);
  }
});
test('search readiness budget and cancellation end observations without repeated paste',async t=>{
  const f=await searchReadinessFixture(t),request=f.driver.client.request;let tick=0,reads=0;
  f.driver.now=()=>tick;f.driver.wait=async ms=>{tick+=ms;};f.driver.client.request=async(action,input)=>{const result=await request(action,input);if(action==='capture'){tick+=40;result.regions[0].rgbaSha256=(++reads%2?'a':'b').repeat(64);}return result;};
  await assert.rejects(f.driver.waitForStableSearchResults(f.baseline),{code:'UI_QT_SEARCH_RESULTS_UNSTABLE'});assert.ok(reads<=9);assert.ok(tick<=640);
  const cancelled=await searchReadinessFixture(t),controller=new AbortController();cancelled.driver.operationSignal=controller.signal;
  cancelled.driver.wait=async()=>controller.abort();await assert.rejects(cancelled.driver.waitForStableSearchResults(cancelled.baseline),{code:'UI_QT_CANCELLED'});assert.equal(cancelled.actions.filter(a=>a.action==='capture').length,1);
});
test('search Escape is issued once and only whole main header/editor readiness replaces its fixed wait',async t=>{
  const f=await searchReadinessFixture(t),waits=[],request=f.driver.client.request;let mainReads=0;
  f.driver.wait=async ms=>waits.push(ms);f.driver.client.request=async(action,input)=>{const result=await request(action,input);if(action==='capture'&&input.surface==='main'){mainReads++;result.regions[1].rgbaSha256=(mainReads===1?'a':'e').repeat(64);}return result;};
  await f.driver.closeObservedSearch(f.baseline);assert.deepEqual(waits,[35,35]);assert.equal(mainReads,3);
  assert.equal(f.actions.filter(a=>a.action==='chord'&&a.key==='Escape').length,1);assert.equal(f.driver.surface,'main');
  const bad=await searchReadinessFixture(t),badRequest=bad.driver.client.request;let changed=false;
  bad.driver.client.request=async(action,input)=>{const result=await badRequest(action,input);if(action==='capture'&&input.surface==='main'){changed=true;result.regions[0].rgbaSha256='a'.repeat(64);}return result;};
  await assert.rejects(bad.driver.closeObservedSearch(bad.baseline),{code:'UI_QT_HEADER_CHANGED'});assert.equal(changed,true);assert.equal(bad.actions.filter(a=>a.action==='chord').length,1);
});
test('a successfully dismissed search popup may still obscure the first read, but every later read must pass native visibility and original header guards',async t=>{
  const f=await searchReadinessFixture(t),request=f.driver.client.request,waits=[];let reads=0;
  f.driver.wait=async ms=>waits.push(ms);f.driver.client.request=async(action,input)=>{
    if(action==='capture'&&input.surface==='main'&&++reads===1)throw Object.assign(Error('popup fading'),{code:'QT_WINDOW_OBSCURED',attempted:false});return request(action,input);
  };
  await f.driver.closeObservedSearch(f.baseline);assert.equal(reads,3);assert.deepEqual(waits,[35,35]);assert.equal(f.actions.filter(a=>a.action==='chord').length,1);
  assert.equal(f.actions.filter(a=>a.action==='capture'&&a.surface==='main').every(a=>a.image===false&&a.regions.length===2),true);
  for(const kind of ['attempted','unknown','other-error','changed-header','changed-thread','changed-epoch','changed-root']){
    const bad=await searchReadinessFixture(t),original=bad.driver.client.request;let count=0;
    bad.driver.client.request=async(action,input)=>{
      if(action==='capture'&&input.surface==='main'&&++count===1){const error=Object.assign(Error('read refused'),{code:kind==='other-error'?'QT_FOCUS_UNAVAILABLE':'QT_WINDOW_OBSCURED',attempted:false});if(kind==='attempted')error.attempted=true;if(kind==='unknown')delete error.attempted;throw error;}
      const result=await original(action,input);if(action==='capture'&&input.surface==='main'){if(kind==='changed-header')result.regions[0].rgbaSha256='a'.repeat(64);if(kind==='changed-thread')result.binding.threadId=99;if(kind==='changed-epoch')result.epoch='f'.repeat(32);if(kind==='changed-root')result.binding.hwnd='101';}return result;
    };
    await assert.rejects(bad.driver.closeObservedSearch(bad.baseline),undefined,kind);assert.equal(count,['attempted','unknown','other-error'].includes(kind)?1:2);assert.equal(bad.actions.filter(a=>a.action==='chord').length,1);
  }
});
test('persistent post-Escape overlap cannot extend the search deadline or alter own-profile close behavior',async t=>{
  const f=await searchReadinessFixture(t),request=f.driver.client.request;let reads=0,tick=0;
  f.driver.now=()=>tick;f.driver.wait=async ms=>{tick+=ms;};f.driver.client.request=async(action,input)=>{if(action==='capture'&&input.surface==='main'){reads++;tick+=30;throw Object.assign(Error('still blocked'),{code:'QT_WINDOW_OBSCURED',attempted:false});}return request(action,input);};
  await assert.rejects(f.driver.closeObservedSearch(f.baseline),{code:'QT_WINDOW_OBSCURED'});assert.ok(reads<=7);assert.ok(tick<=430);assert.equal(f.actions.filter(a=>a.action==='chord').length,1);
  const own=await selfCloseFixture(t),original=own.driver.client.request;let ownReads=0;
  own.driver.client.request=async(action,input)=>{if(action==='capture'&&input.surface==='main'){ownReads++;throw Object.assign(Error('own blocked'),{code:'QT_WINDOW_OBSCURED',attempted:false});}return original(action,input);};
  await assert.rejects(own.close(),{code:'QT_WINDOW_OBSCURED'});assert.equal(ownReads,1);assert.equal(own.actions.filter(a=>a.action==='chord').length,1);
});
test('shared exact database search uses one paste and Return without profile OCR or reopen',async t=>{
  const f=fixture(t,withObservedPopups);f.driver.warmOcr=f.driver.recognize=f.driver.verifyContact=f.driver.locateContactPanel=async()=>{throw Error('shared must not reverify profile');};
  assert.equal((await f.driver.prepare(f.job,{textEntryMode:'paste',interactionPlan:{executionMode:'focus-handoff'}})).ready,true);
  assert.equal(f.actions.filter(a=>a.action==='paste'&&a.scope==='search').length,1);assert.equal(f.actions.filter(a=>a.action==='searchEnter').length,1);
  assert.equal(f.actions.filter(a=>a.action==='chord'&&a.key==='Control+F').length,1);assert.equal(f.actions.some(a=>a.popupTransition&&a.popupTransition.id!=='search'),false);
  assert.equal(f.actions.some(a=>a.key==='Escape'),false);assert.equal(f.driver.current.privateChatProof.kind,'database-query-search-enter-v1');assert.equal(f.actions.filter(a=>a.action==='readDraft').length,0);assert.equal(f.driver.current.draftPolicy,'unchecked');assert.equal(f.actions.find(a=>a.action==='paste').readback,false);
  const ordinary=fixture(t,withObservedPopups);ordinary.driver.locateContactPanel=async input=>panelProof(input);await ordinary.driver.prepare(ordinary.job,{textEntryMode:'paste'});
  assert.equal(ordinary.driver.current.privateChatProof.kind,'exact-private-search-row-v1');assert.equal(ordinary.actions.some(a=>a.action==='searchEnter'),false);
});
test('private contacts without a public alias use a proven unique searchable name while keeping the stable delivery ID',async t=>{
  for(const shared of [true,false]){
    const f=fixture(t,withObservedPopups),contact={wechatId:f.job.target,name:'展示备注',alias:'',ambiguous:false,searchName:'唯一联系人',uniqueSearchName:true};
    f.driver.resolveTarget=async()=>contact;
    f.driver.warmOcr=async()=>{};f.driver.recognize=f.driver.verifyContact=async()=>{throw Error('direct-name query must not reopen profile');};
    const lookup=await f.driver.lookupTarget(f.job);assert.equal(lookup.displayedId,contact.searchName);assert.equal(lookup.searchKind,'private-name');assert.equal(lookup.target,f.job.target);
    assert.equal((await f.driver.prepare(f.job,{interactionPlan:{executionMode:shared?'focus-handoff':'foreground'},textEntryMode:'paste'})).ready,true);
    const pasted=f.actions.filter(a=>a.action==='paste');assert.equal(pasted.length,1);assert.equal(pasted[0].scope,'search');assert.equal(pasted[0].searchKind,'private-name');assert.equal(pasted[0].text,contact.searchName);assert.equal(pasted[0].readback,false);
    assert.equal(f.actions.filter(a=>a.action==='searchEnter').length,1);assert.equal(f.driver.current.privateChatProof.target,f.job.target);assert.equal(f.driver.current.privateChatProof.querySha256,digest(contact.searchName));
    const before=f.actions.length;assert.equal((await f.driver.prepare(f.job,{interactionPlan:{executionMode:shared?'focus-handoff':'foreground'},textEntryMode:'paste'})).ready,true);
    assert.equal(f.actions.slice(before).some(a=>a.action==='searchEnter'||a.action==='paste'),false);
  }
});
test('public aliases and legacy searchable IDs take precedence over names, while unproven names never borrow focus',async t=>{
  const f=fixture(t,withObservedPopups);f.driver.resolveTarget=async()=>({wechatId:f.job.target,alias:'public_alias',ambiguous:false,searchName:'重复昵称',uniqueSearchName:false});
  assert.equal((await f.driver.lookupTarget(f.job)).displayedId,'public_alias');
  f.job.target='legacy_account';f.driver.resolveTarget=async()=>({wechatId:f.job.target,alias:'',ambiguous:false});assert.equal((await f.driver.lookupTarget(f.job)).displayedId,'legacy_account');
  f.job.target='filehelper';await assert.rejects(f.driver.lookupTarget(f.job),{code:'UI_QT_PRIVATE_TARGET_REQUIRED'});
  for(const mutate of [c=>delete c.searchName,c=>c.uniqueSearchName=false,c=>delete c.uniqueSearchName,c=>c.searchName='',c=>c.searchName=' 名称',c=>c.searchName='名字\n换行',c=>c.searchName='room@chatroom',c=>c.searchName='名'.repeat(129),c=>c.searchName='\ud800']){
    const g=fixture(t,withObservedPopups),contact={wechatId:g.job.target,alias:'',ambiguous:false,searchName:'唯一昵称',uniqueSearchName:true};mutate(contact);g.driver.resolveTarget=async()=>contact;
    await assert.rejects(g.driver.prepare(g.job,{interactionPlan:{executionMode:'focus-handoff'}}),{code:'UI_QT_TARGET_SEARCH_NAME_REQUIRED'});assert.equal(g.actions.length,0);
  }
});
test('voice navigation by a private searchable name keeps its original wxid in the native recording session',async t=>{
  const f=fixture(t,withObservedPopups);f.driver.config.voice=adaptiveVoiceCalibration();f.driver.resolveTarget=async()=>({wechatId:f.job.target,alias:'',ambiguous:false,name:'唯一昵称',searchName:'唯一昵称',uniqueSearchName:true});
  const result=await f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff',textEntryMode:'paste'}});
  assert.equal(result.session.target,f.job.target);assert.equal(result.session.targetProof.target,f.job.target);assert.equal(result.session.targetProof.kind,'verified-qt-private-chat-v1');
  assert.equal(f.actions.find(a=>a.action==='paste').searchKind,'private-name');assert.equal(f.actions.find(a=>a.action==='paste').text,'唯一昵称');assert.equal(f.actions.filter(a=>a.action==='searchEnter').length,1);
});
function selectGroupFixture(f){
  f.job.target='fixture-room@chatroom';
  const contact={wechatId:f.job.target,id:123,name:'桌面自动化示例讨论组',alias:'',ambiguous:false,kind:'group',groupName:'桌面自动化示例讨论组',uniqueSearchName:true};
  f.driver.resolveTarget=async()=>contact;return contact;
}
test('unique group title uses one direct search then shared paste and Enter without private profile checks',async t=>{
  const f=fixture(t,withObservedPopups),contact=selectGroupFixture(f);
  f.driver.warmOcr=f.driver.recognize=f.driver.verifyContact=f.driver.locateContactPanel=async()=>{throw Error('group title must not use private profile');};
  await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}});
  const query=f.actions.filter(a=>a.action==='paste'&&a.scope==='search');assert.equal(query.length,1);assert.equal(query[0].text,contact.groupName);assert.equal(query[0].searchKind,'group-title');assert.equal(query[0].readback,false);
  assert.equal(f.actions.filter(a=>a.action==='searchEnter').length,1);assert.equal(f.driver.current.privateChatProof.target,f.job.target);assert.equal(f.driver.current.privateChatProof.querySha256,digest(contact.groupName));
  const state=await f.driver.observe(f.job);assert.equal((await f.driver.pasteText(f.job,{expectedDraft:'',text:'群消息',editorToken:state.editorToken,activityRevision:state.activityRevision},{canInput:()=>true})).performed,true);
  const ready=await f.driver.observe(f.job);assert.equal((await f.driver.submit(f.job,{expectedDraft:'群消息',editorToken:ready.editorToken,activityRevision:ready.activityRevision},{canSubmit:()=>true})).performed,true);
  assert.equal(f.actions.filter(a=>a.action==='submitTextEnter').length,1);assert.equal(f.actions.some(a=>a.action==='readDraft'),false);
});
test('group navigation rejects ambiguous or missing title evidence before borrowing focus or input',async t=>{
  for(const mutate of [c=>c.uniqueSearchName=false,c=>delete c.uniqueSearchName,c=>c.ambiguous=true,c=>c.kind='private',c=>c.name='different',c=>c.groupName='room@chatroom',c=>{c.groupName=c.name='群\n名';}]){
    const f=fixture(t,withObservedPopups),contact=selectGroupFixture(f);mutate(contact);
    await assert.rejects(f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}}),{code:'UI_QT_GROUP_SEARCH_NAME_REQUIRED'});assert.equal(f.actions.length,0);
  }
  const old=fixture(t);selectGroupFixture(old);await assert.rejects(old.driver.prepare(old.job),{code:'UI_QT_GROUP_ADAPTIVE_LAYOUT_REQUIRED'});assert.equal(old.actions.length,0);
});
test('dedicated group navigation uses the unique title rather than the private profile path',async t=>{
  const f=fixture(t,withObservedPopups),contact=selectGroupFixture(f);f.driver.verifyContact=f.driver.locateContactPanel=async()=>{throw Error('no private group profile');};
  await f.driver.prepare(f.job);assert.equal(f.actions.find(a=>a.action==='paste').text,contact.groupName);assert.equal(f.driver.current.privateChatProof.kind,'database-query-search-enter-v1');
  assert.equal(f.actions.some(a=>a.action==='beginFocusHandoff'),false);assert.equal(f.actions.filter(a=>a.action==='readDraft').length,1);
});
test('a new group reply refreshes the catalog even while the same chat remains selected',async t=>{
  const f=fixture(t,withObservedPopups),contact=selectGroupFixture(f);await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}});
  const before=f.actions.length;contact.uniqueSearchName=false;
  await assert.rejects(f.driver.prepare({...f.job,id:'4'.repeat(64)},{interactionPlan:{executionMode:'focus-handoff'}}),{code:'UI_QT_GROUP_SEARCH_NAME_REQUIRED'});
  assert.equal(f.actions.slice(before).some(a=>['paste','searchEnter','submitTextEnter','beginFocusHandoff'].includes(a.action)),false);
});
test('native group voice session retains group ID and unique-title query proof through focus transfer',async t=>{
  const f=fixture(t,withObservedPopups),contact=selectGroupFixture(f);f.driver.config.voice=adaptiveVoiceCalibration();
  f.driver.warmOcr=f.driver.recognize=f.driver.verifyContact=async()=>{throw Error('group voice must not use private profile');};
  const result=await f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff',textEntryMode:'paste'}});
  assert.equal(result.session.target,f.job.target);assert.equal(result.session.targetProof.kind,'verified-qt-group-chat-v1');assert.equal(result.session.targetProof.querySha256,digest(contact.groupName));assert.equal(result.session.targetProof.target,f.job.target);
  assert.equal(f.actions.filter(a=>a.action==='paste').length,1);assert.equal(f.actions.find(a=>a.action==='paste').searchKind,'group-title');assert.equal(f.actions.some(a=>a.action==='readDraft'),false);assert.equal(f.actions.filter(a=>a.action==='transferFocusHandoff').length,1);
});
test('direct search consumes exactly its native post-paste token and refuses mismatched proof or clipboard outcome before Return',async t=>{
  for(const kind of ['valid','missing-frame','wrong-token','wrong-root','wrong-query-region','wrong-proof','wrong-digest','clipboard','unverified','revision']){
    const f=fixture(t,withObservedPopups),request=f.driver.client.request;let expectedToken,afterPaste=[],done=false;
    f.driver.client.request=async(action,input)=>{if(done)afterPaste.push(action);const result=await request(action,input);if(action==='paste'&&input.scope==='search'){
      expectedToken=result.postPasteFrame.token;done=true;
      if(kind==='missing-frame')delete result.postPasteFrame;if(kind==='wrong-token')result.postPasteFrame.token='invalid';if(kind==='wrong-root')result.postPasteFrame.binding.hwnd='999';
      if(kind==='wrong-query-region')result.postPasteFrame.regions[0].rect=r(1,1,10,10);if(kind==='wrong-proof')delete result.searchEnterProof;if(kind==='wrong-digest')result.searchEnterProof.querySha256='0'.repeat(64);
      if(kind==='clipboard')result.clipboardRestored=false;if(kind==='unverified')result.pasteApplied=false;if(kind==='revision')result.postPasteFrame.revision++;
    }return result;};
    const run=f.driver.prepare(f.job,{textEntryMode:'paste',interactionPlan:{executionMode:'focus-handoff'}});
    if(kind==='valid'){assert.equal((await run).ready,true);assert.equal(afterPaste[0],'searchEnter');assert.equal(f.actions.find(a=>a.action==='searchEnter').token,expectedToken);}
    else {let result;try{result=await run;}catch{}assert.notEqual(result?.ready,true,kind);assert.equal(f.actions.some(a=>a.action==='searchEnter'),false,kind);}
    assert.equal(f.actions.filter(a=>a.action==='paste'&&a.scope==='search').length,1,kind);
  }
});
test('shared navigation reuses its input frames and only waits for the two main-ready observations',async t=>{
  const f=fixture(t,withObservedPopups),request=f.driver.client.request,timeline=[],waits=[];let depth=0,tick=Date.now();
  // The expected observation count concerns virtual wait intervals, not a
  // millisecond of host scheduling between two otherwise identical frames.
  f.driver.now=()=>tick;f.driver.config.settleMs=250;f.driver.wait=async ms=>{tick+=ms;waits.push(ms);};
  f.driver.client.request=async(action,input)=>{if(depth===0)timeline.push(action);depth++;try{return await request(action,input);}finally{depth--;}};
  assert.equal((await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}})).ready,true);
  assert.deepEqual(timeline,['inspectFocusHandoff','inspectLayout','beginFocusHandoff','capture','chord','capture','paste','searchEnter','capture','capture','click','capture']);
  assert.deepEqual(waits,[35]);assert.deepEqual(f.actions.filter(a=>a.action==='click').map(a=>a.rect),[f.driver.config.layout.editor]);
});

test('OCR and UIA only accept deliberate clipboard replacement for an authorized paste',async t=>{
  for(const uia of [false,true])for(const outcome of ['authorized','strict','unknown','contradictory']){
    const f=uia?uiaFirstNavigationFixture(t,{ready:count=>count>1}):fixture(t,withObservedPopups);
    f.driver.allowClipboardReplacement=outcome!=='strict';
    const request=f.driver.client.request,scopes=[];
    f.driver.client.request=async(action,input)=>{
      const result=await request(action,input);
      if(action==='paste'){
        assert.equal(input.allowClipboardReplacement,outcome!=='strict');
        scopes.push(input.scope);
        result.clipboardRestored=outcome==='contradictory';
        if(outcome!=='unknown')result.clipboardReplaced=true;
      }
      return result;
    };
    const prepare=f.driver.prepare(f.job,f.plan??{interactionPlan:{executionMode:'focus-handoff'},textEntryMode:'paste'});
    if(outcome!=='authorized'){
      await assert.rejects(prepare,{code:'UI_QT_PASTE_UNCONFIRMED'});
      assert.deepEqual(scopes,['search']);
      assert.equal(f.actions.some(a=>a.action==='searchEnter'),false);
      continue;
    }
    assert.equal((await prepare).ready,true);
    const observed=await f.driver.observe(f.job);
    assert.equal((await f.driver.pasteText(f.job,{expectedDraft:'',text:f.job.text,editorToken:observed.editorToken,activityRevision:observed.activityRevision},{canInput:()=>true})).performed,true);
    assert.deepEqual(scopes,['search','editor']);
    assert.equal(f.actions.some(a=>a.action==='type'||a.action==='typeText'),false);
    await f.driver.releaseTextFocus();
  }
});

test('an original clipboard refusal is retryable only after cleaning up search and focus',async t=>{
  for(const variant of ['clean','unmarked','failed-close','failed-restore']){
    const f=fixture(t,withObservedPopups),request=f.driver.client.request;
    f.driver.client.request=async(action,input)=>{
      if(action==='paste'&&input.scope==='search'){
        throw Object.assign(Error('refused'),{code:'DRAFT_CLIPBOARD_COMPLEX_FORMAT',attempted:false,
          originalClipboardBlocked:variant!=='unmarked',clipboardRestored:true});
      }
      if(variant==='failed-close'&&action==='chord'&&input.key==='Escape')throw Error('close failed');
      if(variant==='failed-restore'&&action==='releaseFocusHandoff')return{restored:false,skipped:true};
      return request(action,input);
    };
    const prepare=f.driver.prepare(f.job,{textEntryMode:'paste',interactionPlan:{executionMode:'focus-handoff'}});
    if(variant==='clean'){
      assert.deepEqual(await prepare,{ready:false,reason:'DRAFT_CLIPBOARD_COMPLEX_FORMAT',clipboardPreparationClean:true});
    }else await assert.rejects(prepare,error=>error.clipboardPreparationClean!==true);
    assert.equal(f.actions.some(a=>a.action==='searchEnter'||a.action==='submitTextEnter'),false);
  }
});
test('shared search popup startup only retries bounded observations without another Ctrl+F or click',async t=>{
  for(const kind of ['pending','unstable','pixels','deadline','activity','wrong-pixels']){
    const f=fixture(t,withObservedPopups),request=f.driver.client.request;let tick=0,reads=0;
    f.driver.now=()=>tick;f.driver.wait=async ms=>{assert.equal(ms,35);tick+=ms;};
    f.driver.client.request=async(action,input)=>{
      if(action==='capture'&&input.surface==='observed-search'&&++reads<=(kind==='deadline'?100:2)){
        const code=kind==='activity'?'QT_HUMAN_ACTIVITY_CHANGED':kind==='unstable'?'QT_POPUP_UNSTABLE':['pixels','wrong-pixels'].includes(kind)?'QT_PIXELS_CHANGED':'QT_POPUP_CANDIDATE_NOT_UNIQUE';
        throw Object.assign(Error('query pending'),{code,attempted:false,...(code==='QT_PIXELS_CHANGED'?{pixelMismatch:{stage:kind==='wrong-pixels'?'guard':'capture',anchorIndex:0}}:{})});
      }
      return request(action,input);
    };
    let result,error;try{result=await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}});}catch(value){error=value;}
    assert.equal(f.actions.filter(a=>a.key==='Control+F').length,1,kind);
    assert.equal(f.actions.some(a=>a.action==='click'&&sameFixtureRect(a.rect,f.driver.config.layout.search)),false,kind);
    if(['pending','unstable','pixels'].includes(kind)){assert.equal(result.ready,true);assert.equal(tick,105);}
    else{assert.notEqual(result?.ready,true);assert.equal(f.actions.some(a=>a.action==='paste'||a.action==='searchEnter'),false);assert.ok(tick<=600);if(kind==='deadline')assert.equal(error.code,'UI_QT_SEARCH_TRANSITION_UNCONFIRMED');else assert.equal(tick,0);}
  }
});
test('interrupted search paste restarts the complete query after focus returns',async t=>{
  const f=fixture(t,withObservedPopups),request=f.driver.client.request;let interrupt=true;
  f.driver.client.request=async(action,input)=>{const result=await request(action,input);if(action==='paste'&&input.scope==='search'&&interrupt){interrupt=false;f.setRevision(1);throw Object.assign(Error('search interrupted'),{code:'QT_HUMAN_ACTIVITY_CHANGED',attempted:true,clipboardRestored:true});}return result;};
  assert.deepEqual(await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}}),{ready:false,reason:'QT_HUMAN_ACTIVITY_CHANGED'});
  assert.equal(f.actions.some(a=>a.action==='searchEnter'||a.scope==='editor'),false);
  assert.equal((await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}})).ready,true);
  assert.equal(f.actions.filter(a=>a.key==='Control+F').length,2);
  const pasted=f.actions.filter(a=>a.action==='paste');assert.equal(pasted.length,2);assert.equal(pasted.every(a=>a.scope==='search'&&a.replaceSearch===true&&a.readback===false&&a.text==='target_A'),true);
});
test('direct search Return failure never repeats Enter or sends chat input, and a new attempt replaces the complete query',async t=>{
  for(const attempted of [false,true]){
    const f=fixture(t,withObservedPopups),request=f.driver.client.request;let enters=0;
    f.driver.client.request=async(action,input)=>{if(action==='searchEnter'){enters++;throw Object.assign(Error('interrupted'),{code:'QT_HUMAN_ACTIVITY_CHANGED',attempted});}return request(action,input);};
    assert.equal((await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}})).ready,false);assert.equal(enters,1);assert.equal(f.actions.some(a=>a.action==='readDraft'||a.action==='submitTextEnter'||a.scope==='editor'),false);
    f.driver.client.request=request;f.setRevision(1);
    assert.equal((await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}})).ready,true);
    const pastes=f.actions.filter(a=>a.action==='paste'&&a.scope==='search');assert.equal(pastes.length,2);assert.equal(pastes.every(a=>a.replaceSearch&&a.text==='target_A'),true);
  }
});
test('bounded search observation failures carry navigation-only evidence after one confirmed return or an unborrowed foreground session',async t=>{
  for(const phase of ['query','chat'])for(const foreground of [false,true]){
    const f=fixture(t,withObservedPopups),request=f.driver.client.request;let tick=0,entered=false;
    f.driver.now=()=>tick;f.driver.wait=async ms=>{tick+=ms;};
    f.driver.client.request=async(action,input)=>{
      if(foreground&&action==='inspectFocusHandoff')return{ready:false,reason:'QT_FOCUS_RETURN_WINDOW_REQUIRED',inputSent:false,clipboardAccessed:false,focusChanged:false};
      if(action==='capture'&&(phase==='query'&&input.surface==='observed-search'||phase==='chat'&&entered&&input.surface==='main'))throw Object.assign(Error('transition pending'),{code:phase==='query'?'QT_POPUP_CANDIDATE_NOT_UNIQUE':'QT_WINDOW_OBSCURED',attempted:false});
      const result=await request(action,input);if(action==='searchEnter')entered=true;return result;
    };
    await assert.rejects(f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}}),error=>{
      assert.equal(error.code,'UI_QT_SEARCH_TRANSITION_UNCONFIRMED');
      assert.deepEqual(error.navigationRefusal,{version:1,focus:foreground?'not-borrowed':'restored',messageInputAttempted:false});return true;
    });
    assert.equal(f.actions.filter(a=>a.action==='releaseFocusHandoff').length,foreground?0:1);
    assert.equal(f.actions.filter(a=>a.action==='searchEnter').length,phase==='chat'?1:0);
    assert.equal(f.actions.some(a=>a.scope==='editor'||a.action==='submitTextEnter'),false);
    assert.equal(f.driver.current,null);assert.equal(f.driver.transaction,null);assert.equal(f.driver.surface,'main');
  }
});
test('a bare transition code or unconfirmed cleanup never authorizes navigation retry',async t=>{
  for(const failure of ['bare','skipped','return-error','popup','clipboard']){
    const f=fixture(t,withObservedPopups),request=f.driver.client.request;let tick=0;
    f.driver.now=()=>tick;f.driver.wait=async ms=>{tick+=ms;};
    f.driver.client.request=async(action,input)=>{
      if(action==='capture'&&input.surface==='observed-search')throw Object.assign(Error('pending'),{code:'QT_POPUP_CANDIDATE_NOT_UNIQUE',attempted:false});
      if(action==='releaseFocusHandoff'&&failure==='skipped')return{restored:false,skipped:true};
      if(action==='releaseFocusHandoff'&&failure==='return-error')throw Object.assign(Error('return failed'),{code:'QT_FOCUS_RETURN_UNCONFIRMED'});
      return request(action,input);
    };
    if(failure==='bare')f.driver.waitForSharedSearchQuery=async()=>{throw Object.assign(Error('unproven'),{code:'UI_QT_SEARCH_TRANSITION_UNCONFIRMED'});};
    if(failure==='popup')f.driver.closePreparationPopupAfterFailure=async()=>{throw Object.assign(Error('popup cleanup failed'),{code:'QT_POPUP_BINDING_CHANGED'});};
    if(failure==='clipboard'){const wait=f.driver.waitForSharedSearchQuery.bind(f.driver);f.driver.waitForSharedSearchQuery=async()=>{try{return await wait();}catch(error){error.clipboardRestored=false;throw error;}};}
    await assert.rejects(f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}}),error=>{assert.equal(error.navigationRefusal,undefined);return true;});
    assert.equal(f.actions.some(a=>a.scope==='editor'||a.action==='submitTextEnter'),false);
  }
});
test('shared voice navigation only permits retry after its outer lease has returned without starting recording',async t=>{
  for(const returned of [true,false]){
    const f=fixture(t,withObservedPopups),request=f.driver.client.request;f.driver.config.voice=adaptiveVoiceCalibration();let tick=0,releases=0;
    f.driver.now=()=>tick;f.driver.wait=async ms=>{tick+=ms;};
    f.driver.client.request=async(action,input)=>{
      if(action==='capture'&&input.surface==='observed-search')throw Object.assign(Error('pending'),{code:'QT_POPUP_CANDIDATE_NOT_UNIQUE',attempted:false});
      if(action==='releaseFocusHandoff'){releases++;return{restored:returned,skipped:!returned};}
      return request(action,input);
    };
    await assert.rejects(f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff',textEntryMode:'paste'}}),error=>{
      assert.equal(releases,1);assert.equal(error.code,'UI_QT_SEARCH_TRANSITION_UNCONFIRMED');
      assert.deepEqual(error.navigationRefusal,returned?{version:1,focus:'restored',messageInputAttempted:false}:undefined);return true;
    });
    assert.equal(f.actions.some(a=>a.action==='transferFocusHandoff'||a.action==='click'||a.scope==='editor'||a.action==='submitTextEnter'),false);
  }
});
test('direct Enter transition needs two fresh main frames after a changed header or the unchanged presentation grace',async t=>{
  for(const kind of ['same','transient','no-caret','missing-caret','no-caret-contradiction','popup','query-caret','changed-root','activity']){
    const f=await titleFixture(t),baseline=await f.driver.capture(['header']),request=f.driver.client.request;let tick=0,reads=0;
    f.driver.now=()=>tick;f.driver.wait=async ms=>{tick+=ms;};
    f.driver.client.request=async(action,input)=>{if(action==='capture')reads++;if(kind==='popup')throw Object.assign(Error('popup visible'),{code:'QT_WINDOW_OBSCURED',attempted:false});const frame=await request(action,input);
      Object.assign(frame.binding,{focusBelongsToWindow:true,caretHwnd:'100',caretBelongsToWindow:true,guiFlags:1,caretRectInClient:kind==='query-caret'?r(100,30,102,32):r(320,470,322,472)});
      if(['no-caret','no-caret-contradiction'].includes(kind))Object.assign(frame.binding,{caretHwnd:'0',caretBelongsToWindow:false,guiFlags:0,caretRectInClient:r(0,0,0,0)});
      if(kind==='missing-caret')delete frame.binding.caretHwnd;if(kind==='no-caret-contradiction')frame.binding.caretRectInClient.right=1;
      if(kind==='transient'&&reads>=2)frame.regions[0].rgbaSha256='b'.repeat(64);if(kind==='changed-root')frame.binding.hwnd='999';if(kind==='activity')frame.revision++;return frame;};
    if(['same','transient','no-caret'].includes(kind)){const result=await f.driver.waitForSearchEnterTransition(baseline);assert.equal(tick,kind==='transient'?70:385);assert.equal(result.regions[0].rgbaSha256,(kind==='transient'?'b':'d').repeat(64));}
    else await assert.rejects(f.driver.waitForSearchEnterTransition(baseline));
    assert.equal(f.actions.some(a=>['click','searchEnter','paste'].includes(a.action)),false);
  }
});
test('search presentation never accepts stable old frames before delayed new headers or reuses old frames after a change',async t=>{
  for(const kind of ['measured-delay','late-transition','reverts','unchanged']){
    const f=await titleFixture(t),baseline=await f.driver.capture(['header']),request=f.driver.client.request;let tick=0;
    f.driver.now=()=>tick;f.driver.wait=async ms=>{assert.equal(ms,35);tick+=ms;};
    f.driver.client.request=async(action,input)=>{const frame=await request(action,input);Object.assign(frame.binding,{focusBelongsToWindow:true,caretHwnd:'100',caretBelongsToWindow:true,guiFlags:1,caretRectInClient:r(320,470,322,472)});
      if(kind==='measured-delay'&&tick>=230||kind==='late-transition'&&tick>=370||kind==='reverts'&&tick>=70&&tick<105)frame.regions[0].rgbaSha256='b'.repeat(64);return frame;};
    if(kind==='reverts'){await assert.rejects(f.driver.waitForSearchEnterTransition(baseline),{code:'UI_QT_SEARCH_TRANSITION_UNCONFIRMED'});assert.ok(tick<=600);}
    else{const frame=await f.driver.waitForSearchEnterTransition(baseline);assert.equal(tick,kind==='measured-delay'?280:kind==='late-transition'?420:385);assert.equal(frame.regions[0].rgbaSha256,(kind==='unchanged'?'d':'b').repeat(64));}
    assert.equal(f.actions.some(a=>['click','paste','searchEnter','submitTextEnter'].includes(a.action)),false);
  }
});
test('shared prepare keeps editor focus and body input after delayed page presentation',async t=>{
  const f=fixture(t,withObservedPopups),request=f.driver.client.request;let tick=0,enteredAt,oldHeader;
  f.driver.now=()=>tick;f.driver.wait=async ms=>{tick+=ms;};
  f.driver.client.request=async(action,input)=>{
    if(action==='click'&&sameFixtureRect(input.rect,f.driver.config.layout.editor))assert.ok(tick-enteredAt>=280);
    const result=await request(action,input);
    if(action==='capture'&&enteredAt===undefined&&input.surface==='main')oldHeader=result.regions[0].rgbaSha256;
    if(action==='searchEnter')enteredAt=tick;
    if(action==='capture'&&input.surface==='main'&&enteredAt!==undefined&&tick-enteredAt<230)result.regions[0].rgbaSha256=oldHeader;
    return result;
  };
  assert.equal((await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}})).ready,true);
  assert.equal(tick-enteredAt,280);assert.equal(f.actions.some(a=>a.action==='paste'&&a.scope==='editor'||a.action==='submitTextEnter'),false);
});
test('a direct search opening without a caret explicitly focuses its editor without checking the draft',async t=>{
  const f=fixture(t,withObservedPopups),request=f.driver.client.request;let entered=false,editorFocused=false,draftReads=0;
  f.driver.client.request=async(action,input)=>{
    if(action==='click'&&sameFixtureRect(input.rect,f.driver.config.layout.editor)){assert.equal(entered,true);editorFocused=true;}
    if(action==='readDraft'){assert.equal(editorFocused,true);draftReads++;}
    const result=await request(action,input);if(action==='searchEnter')entered=true;
    if(entered&&!editorFocused&&action==='capture'&&input.surface==='main')Object.assign(result.binding,{focusBelongsToWindow:true,caretHwnd:'0',caretBelongsToWindow:false,guiFlags:0,caretRectInClient:r(0,0,0,0)});
    return result;
  };
  assert.equal((await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}})).ready,true);
  assert.equal(editorFocused,true);assert.equal(draftReads,0);assert.equal(f.driver.current.draftPolicy,'unchecked');assert.equal(f.actions.filter(a=>a.action==='searchEnter').length,1);assert.equal(f.actions.some(a=>a.action==='paste'&&a.scope==='editor'||a.action==='submitTextEnter'),false);
});
test('shared editor paste uses its applied-input intent directly without copying or an extra observation before Enter',async t=>{
  const f=fixture(t,withObservedPopups);await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}});const observation=await f.driver.observe(f.job),before=f.actions.length;
  const pasted=await f.driver.pasteText(f.job,{expectedDraft:'',text:'正文',editorToken:observation.editorToken,activityRevision:observation.activityRevision},{canInput:()=>true});assert.equal(pasted.performed,true);
  assert.equal(f.actions.slice(before).filter(a=>a.action==='readDraft').length,0);assert.equal(f.driver.current.draft,'正文');assert.equal(f.driver.current.textEnterProof.textSha256,digest('正文'));
  const nextTick=f.actions.length;assert.equal((await f.driver.prepare({...f.job,index:2},{interactionPlan:{executionMode:'focus-handoff'}})).ready,true);assert.deepEqual(f.actions.slice(nextTick).map(a=>a.action),[]);
  const current=await f.driver.observe(f.job);assert.equal((await f.driver.submit(f.job,{expectedDraft:'正文',editorToken:current.editorToken,activityRevision:current.activityRevision},{canSubmit:()=>true})).performed,true);
  assert.equal(f.actions.filter(a=>a.action==='submitTextEnter').length,1);assert.equal(f.actions.slice(before).some(a=>a.action==='click'),false);assert.equal(f.actions.slice(before).some(a=>a.action==='parkFocusHandoff'),false);
});
async function completedNavigationFixture(t,{group=false,uia=false}={}){
  const f=fixture(t,withObservedPopups,uia?{verifyControls:async()=>({verified:true,proof:'uia-controls-v1'})}:{}),clock={value:Date.now()},plan={textEntryMode:'paste',interactionPlan:{executionMode:'focus-handoff'}};
  const contact=group?selectGroupFixture(f):undefined;
  f.driver.now=()=>clock.value;f.driver.wait=async ms=>{clock.value+=ms;};
  assert.equal((await f.driver.prepare(f.job,plan)).ready,true);
  let observed=await f.driver.observe(f.job);
  assert.equal((await f.driver.pasteText(f.job,{expectedDraft:'',text:'已发送的正文',editorToken:observed.editorToken,activityRevision:observed.activityRevision},{canInput:()=>true})).performed,true);
  observed=await f.driver.observe(f.job);
  assert.equal((await f.driver.submit(f.job,{expectedDraft:'已发送的正文',editorToken:observed.editorToken,activityRevision:observed.activityRevision},{canSubmit:()=>true})).performed,true);
  f.setDraft('');f.setEditor('e'.repeat(64));f.actions.length=0;
  return{...f,clock,plan,contact,next:{...f.job,id:'7'.repeat(64),text:'下一段正文'}};
}

test('a completed same-chat text reply reuses navigation only and clicks the editor with its existing fresh first frame',async t=>{
  const f=await completedNavigationFixture(t),request=f.driver.client.request;let captures=0,initialToken;
  f.driver.client.request=async(action,input)=>{const value=await request(action,input);if(action==='capture'){
    value.token=(++captures+10).toString(16).padStart(32,'0');initialToken??=value.token;
  }return value;};
  assert.equal((await f.driver.prepare(f.next,f.plan)).ready,true);
  assert.deepEqual(f.actions.map(a=>a.action),['inspectFocusHandoff','inspectLayout','beginFocusHandoff','capture','click','capture']);
  assert.equal(f.actions.find(a=>a.action==='click').token,initialToken);
  assert.equal(captures,2);assert.equal(f.driver.current.draft,'');assert.equal(f.driver.current.textEnterProof,undefined);
  assert.equal(f.driver.current.privateChatProof.target,f.next.target);
  let ready=await f.driver.observe(f.next);
  assert.equal((await f.driver.pasteText(f.next,{expectedDraft:'',text:f.next.text,editorToken:ready.editorToken,activityRevision:ready.activityRevision},{canInput:()=>true})).performed,true);
  ready=await f.driver.observe(f.next);
  assert.equal((await f.driver.submit(f.next,{expectedDraft:f.next.text,editorToken:ready.editorToken,activityRevision:ready.activityRevision},{canSubmit:()=>true})).performed,true);
  assert.equal(f.actions.filter(a=>a.action==='beginFocusHandoff').length,1);assert.equal(f.actions.filter(a=>a.action==='releaseFocusHandoff').length,1);
  assert.equal(f.actions.filter(a=>a.action==='paste').length,1);assert.equal(f.actions.filter(a=>a.action==='submitTextEnter').length,1);
  assert.equal(f.actions.some(a=>a.action==='readDraft'||a.action==='searchEnter'||a.action==='parkFocusHandoff'||a.action==='resumeFocusHandoff'),false);
});

test('real UIA verification preserves same-chat reuse with one fresh native header and no additional initial wait',async t=>{
  const f=await completedNavigationFixture(t,{uia:true}),request=f.driver.client.request;let captures=0,clicked=false;const waits=[],checks=[];
  f.driver.verifyControls=async({operation})=>{checks.push(operation);return{verified:true,proof:'uia-controls-v1'};};
  f.driver.wait=async ms=>{f.clock.value+=ms;if(!clicked)waits.push(ms);};
  f.driver.client.request=async(action,input)=>{if(action==='capture'&&!clicked)captures++;if(action==='click'){assert.equal(captures,1);clicked=true;}return request(action,input);};
  assert.equal((await f.driver.prepare(f.next,f.plan)).ready,true);assert.equal(captures,1);assert.deepEqual(waits,[]);assert.deepEqual(checks,['prepare']);
  assert.equal(f.actions.some(a=>['chord','paste','searchEnter'].includes(a.action)),false);
});

test('UIA continuation falls back after a transient capture and permanently rejects a mismatching first header',async t=>{
  for(const kind of ['capture-redraw','first-header-mismatch']){
    const f=await completedNavigationFixture(t,{uia:true}),request=f.driver.client.request;let captures=0;
    f.driver.client.request=async(action,input)=>{
      if(action==='capture'&&++captures===1&&kind==='capture-redraw')throw Object.assign(Error('redraw'),{code:'QT_PIXELS_CHANGED',attempted:false,pixelMismatch:{stage:'capture',anchorIndex:0}});
      const frame=await request(action,input);
      if(action==='capture'&&captures===1&&kind==='first-header-mismatch')frame.regions[0].rgbaSha256='b'.repeat(64);
      return frame;
    };
    assert.equal((await f.driver.prepare(f.next,f.plan)).ready,true,kind);
    assert.equal(f.actions.filter(a=>a.action==='searchEnter').length,kind==='first-header-mismatch'?1:0,kind);
    const firstInput=f.actions.findIndex(a=>['chord','click'].includes(a.action));assert.ok(f.actions.slice(0,firstInput).filter(a=>a.action==='capture').length>=2);
  }
});

test('completed navigation falls back to search after target, activity, account, process, display, title or time changes',async t=>{
  for(const kind of ['target','activity','epoch','account-ref','hwnd','pid','created','thread','dpi','width','position','header','expired','clock-reversed']){
    const f=await completedNavigationFixture(t),request=f.driver.client.request,probe=f.driver.probeAccount;
    if(kind==='target')f.next.target='wxid_other';if(kind==='activity')f.setRevision(1);if(kind==='header')f.setHeader('8'.repeat(64));
    if(kind==='account-ref')f.driver.config.accountRef='c'.repeat(64);if(kind==='hwnd')f.driver.config.hwnd='auto';if(kind==='dpi')f.driver.config.layout.dpi=144;if(kind==='width')f.driver.config.layout.width++;
    if(kind==='expired')f.clock.value+=30001;if(kind==='clock-reversed')f.clock.value-=1;
    f.driver.probeAccount=async input=>{const value=await probe(input);value.accountRef=value.accountScopeHash=input.expectedAccountRef;value.evidence.processId=input.binding.pid;value.evidence.processCreatedFileTimeUtc=input.binding.processCreatedFileTimeUtc;return value;};
    f.driver.client.request=async(action,input)=>{
      const value=structuredClone(await request(action,input));if(value.binding){
        if(kind==='hwnd')value.binding.hwnd='101';if(kind==='pid')value.binding.pid=43;if(kind==='created')value.binding.processCreatedFileTimeUtc='12346';if(kind==='thread')value.binding.threadId=8;
        if(kind==='dpi'){value.binding.dpi=144;if(value.popup)value.popup.dpi=144;}
        if(kind==='width'){value.binding.clientRect.right++;value.binding.captureRect.right++;}
        if(kind==='position'){value.binding.captureRect.left++;value.binding.captureRect.right++;if(value.popup){value.popup.windowRect.left++;value.popup.windowRect.right++;}}
        if(kind==='hwnd'){value.binding.focusHwnd='101';if(value.binding.caretHwnd==='100')value.binding.caretHwnd='101';}
      }if(kind==='epoch'&&action==='capture')value.epoch='4'.repeat(32);return value;
    };
    assert.equal((await f.driver.prepare(f.next,f.plan)).ready,true,kind);
    assert.equal(f.actions.filter(a=>a.action==='searchEnter').length,1,kind);
    assert.equal(f.actions.filter(a=>a.action==='paste'&&a.scope==='search').length,1,kind);
    assert.equal(f.actions.some(a=>a.scope==='editor'||a.action==='submitTextEnter'),false,kind);
  }
});

test('interruption during the reused editor click consumes navigation evidence and recovery searches again',async t=>{
  const f=await completedNavigationFixture(t);f.setFailure('click','QT_HUMAN_ACTIVITY_CHANGED');
  assert.deepEqual(await f.driver.prepare(f.next,f.plan),{ready:false,reason:'QT_HUMAN_ACTIVITY_CHANGED'});
  assert.equal(f.actions.some(a=>a.action==='searchEnter'||a.action==='paste'),false);
  f.setFailure(null);f.actions.length=0;
  assert.equal((await f.driver.prepare(f.next,f.plan)).ready,true);
  assert.equal(f.actions.filter(a=>a.action==='searchEnter').length,1);
});

test('completed group navigation still resolves the current catalog and cannot bypass an ambiguous title',async t=>{
  const valid=await completedNavigationFixture(t,{group:true});
  assert.equal((await valid.driver.prepare(valid.next,valid.plan)).ready,true);
  assert.equal(valid.actions.some(a=>a.action==='searchEnter'||a.action==='paste'),false);
  const rejected=await completedNavigationFixture(t,{group:true});rejected.contact.uniqueSearchName=false;
  await assert.rejects(rejected.driver.prepare(rejected.next,rejected.plan),{code:'UI_QT_GROUP_SEARCH_NAME_REQUIRED'});
  assert.equal(rejected.actions.some(a=>a.action==='beginFocusHandoff'||a.action==='click'),false);
  rejected.contact.uniqueSearchName=true;
  assert.equal((await rejected.driver.prepare(rejected.next,rejected.plan)).ready,true);
  assert.equal(rejected.actions.filter(a=>a.action==='searchEnter').length,1);
});

test('uncertain native submission never establishes navigation evidence for another delivery',async t=>{
  for(const kind of ['exception','performed-false','missing-enter-proof']){
    const f=fixture(t,withObservedPopups),plan={interactionPlan:{executionMode:'focus-handoff'}};
    await f.driver.prepare(f.job,plan);let ready=await f.driver.observe(f.job);
    await f.driver.pasteText(f.job,{expectedDraft:'',text:'正文',editorToken:ready.editorToken,activityRevision:ready.activityRevision},{canInput:()=>true});
    const request=f.driver.client.request;
    f.driver.client.request=async(action,input)=>{if(action==='submitTextEnter'){
      if(kind==='exception')throw Object.assign(Error('uncertain'),{code:'QT_INPUT_UNCERTAIN',attempted:true});
      const value=await request(action,input);if(kind==='performed-false')value.performed=false;else delete value.submittedViaEnter;return value;
    }return request(action,input);};
    ready=await f.driver.observe(f.job);
    await assert.rejects(f.driver.submit(f.job,{expectedDraft:'正文',editorToken:ready.editorToken,activityRevision:ready.activityRevision},{canSubmit:()=>true}));
    f.driver.client.request=request;f.setDraft('');f.actions.length=0;
    // The production outbox retains its uncertain delivery barrier. Exercising
    // the driver directly here only proves it did not retain a navigation fast path.
    assert.equal((await f.driver.prepare({...f.job,id:'8'.repeat(64)},plan)).ready,true);
    assert.equal(f.actions.filter(a=>a.action==='searchEnter').length,1,kind);
    assert.equal(f.actions.some(a=>a.scope==='editor'||a.action==='submitTextEnter'),false,kind);
  }
});

test('shared paste post-frame or text proof failure never retries paste and missing submit proof never falls back to clicking send',async t=>{
  for(const kind of ['post-frame','header','revision','proof','digest','submit-proof','revoked']){
    const f=fixture(t,withObservedPopups);await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}});const state=await f.driver.observe(f.job),request=f.driver.client.request;
    f.driver.client.request=async(action,input)=>{const result=await request(action,input);if(action==='paste'&&input.scope==='editor'){
      if(kind==='post-frame')delete result.postPasteFrame;if(kind==='header')result.postPasteFrame.regions[0].rgbaSha256='a'.repeat(64);if(kind==='revision')result.postPasteFrame.revision++;
      if(kind==='proof')delete result.textEnterProof;if(kind==='digest')result.textEnterProof.textSha256='0'.repeat(64);
    }return result;};
    const paste=f.driver.pasteText(f.job,{expectedDraft:'',text:'正文',editorToken:state.editorToken,activityRevision:state.activityRevision},{canInput:()=>true});
    if(['submit-proof','revoked'].includes(kind)){
      assert.equal((await paste).performed,true);if(kind==='submit-proof')delete f.driver.current.textEnterProof;const ready=await f.driver.observe(f.job);
      assert.equal((await f.driver.submit(f.job,{expectedDraft:'正文',editorToken:ready.editorToken,activityRevision:ready.activityRevision},{canSubmit:()=>kind!=='revoked'})).attempted,false);
    }else await assert.rejects(paste);
    assert.equal(f.actions.filter(a=>a.action==='paste'&&a.scope==='editor').length,1);assert.equal(f.actions.some(a=>a.action==='submitTextEnter'||a.action==='click'&&sameFixtureRect(a.rect,f.driver.config.layout.send)),false);
  }
});
async function pastedSharedFixture(t){
  const f=fixture(t,withObservedPopups);await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}});const ready=await f.driver.observe(f.job);
  assert.equal((await f.driver.pasteText(f.job,{text:'已粘贴正文',expectedDraft:'',editorToken:ready.editorToken,activityRevision:ready.activityRevision},{canInput:()=>true})).performed,true);
  return f;
}
test('native applied paste interrupted by human activity saves its cumulative intent and resumes only Enter',async t=>{
  for(const prefix of ['','前缀']){
    const f=fixture(t,withObservedPopups);await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}});
    if(prefix){const state=await f.driver.observe(f.job);await f.driver.pasteText(f.job,{text:prefix,expectedDraft:'',editorToken:state.editorToken,activityRevision:state.activityRevision},{canInput:()=>true});}
    const state=await f.driver.observe(f.job),original=structuredClone(f.driver.current),request=f.driver.client.request,text=prefix+'正文';
    f.driver.client.request=async(action,input)=>{const result=await request(action,input);if(action==='paste'&&input.scope==='editor'){delete result.postPasteFrame;result.interrupted=true;f.setRevision(1);f.setDraft('人工修改');f.setEditor('8'.repeat(64));}return result;};
    assert.deepEqual(await f.driver.pasteText(f.job,{text:'正文',expectedDraft:prefix,editorToken:state.editorToken,activityRevision:state.activityRevision},{canInput:()=>true}),{performed:true,attempted:true});
    assert.equal((await f.driver.observe(f.job)).ready,false);assert.equal(f.driver.textResume.draft,text);assert.equal(f.driver.textResume.draftPolicy,'unchecked');assert.deepEqual(f.driver.textResume.binding,original.binding);assert.equal(f.driver.textResume.header,original.header);
    f.driver.probeAccount=f.driver.resolveTarget=f.driver.recognize=async()=>{throw Error('resume must not repeat completed preparation');};
    const before=f.actions.length,job={...f.job,text,index:prefix.length,pendingInput:{text:'正文',count:2}};
    assert.equal((await f.driver.prepare(job,{interactionPlan:{executionMode:'focus-handoff'}})).ready,true);
    const ready=await f.driver.observe(job);assert.equal(ready.draft,text);
    assert.equal((await f.driver.submit(job,{expectedDraft:text,editorToken:ready.editorToken,activityRevision:ready.activityRevision},{canSubmit:()=>true})).performed,true);
    const resumed=f.actions.slice(before);assert.equal(resumed.filter(a=>a.action==='resumeTextEnterProof').length,1);assert.equal(resumed.filter(a=>a.action==='submitTextEnter').length,1);assert.equal(resumed.some(a=>['readDraft','paste','click','chord','searchEnter'].includes(a.action)),false);
  }
});
test('completed text paste resumes only its pending submit after human activity without copying searching or pasting again',async t=>{
  for(const variant of ['released','submit-refused','editor-pixels-changed']){
    const f=await pastedSharedFixture(t),job={...f.job,index:5,pendingInput:{text:'已粘贴正文',count:5}},pending=structuredClone(job.pendingInput);
    const original=structuredClone(f.driver.current),step={version:1,deliveryId:job.id,accountSha256:digest(job.account),targetSha256:digest(job.target)};
    assert.deepEqual(f.actions.find(a=>a.action==='paste'&&a.scope==='editor').stepBinding,step);
    if(variant==='submit-refused'){
      const ready=await f.driver.observe(job);f.setFailure('submitTextEnter','QT_HUMAN_ACTIVITY_CHANGED',{attempted:false});
      assert.deepEqual(await f.driver.submit(job,{expectedDraft:original.draft,editorToken:ready.editorToken,activityRevision:ready.activityRevision},{canSubmit:()=>true}),{performed:false,attempted:false,reason:'QT_HUMAN_ACTIVITY_CHANGED'});f.setFailure(null);
    }
    await f.driver.releaseTextFocus();f.setRevision(1);if(variant==='editor-pixels-changed'){f.setEditor('1'.repeat(64));f.setDraft('用户修改');}
    f.driver.probeAccount=f.driver.resolveTarget=f.driver.recognize=async()=>{throw Error('completed step must not repeat account/search/OCR');};
    const before=f.actions.length;assert.equal((await f.driver.prepare(job,{interactionPlan:{executionMode:'focus-handoff'}})).ready,true);
    assert.deepEqual(job.pendingInput,pending);assert.equal(f.driver.current.draft,original.draft);assert.equal(f.driver.current.revision,1);assert.equal(f.driver.current.textEnterProof.id,'c'.repeat(32));assert.notEqual(f.driver.current.editorToken,original.editorToken);
    const calls=f.actions.slice(before);assert.equal(calls.filter(a=>a.action==='resumeTextEnterProof').length,1);assert.equal(calls.some(a=>['readDraft','paste','click','chord','searchEnter','movePointer','parkFocusHandoff'].includes(a.action)),false);
    assert.deepEqual(calls.find(a=>a.action==='resumeTextEnterProof').stepBinding,step);
    const ready=await f.driver.observe(job);assert.equal((await f.driver.submit(job,{expectedDraft:original.draft,editorToken:ready.editorToken,activityRevision:ready.activityRevision},{canSubmit:()=>true})).performed,true);
    assert.equal(f.actions.filter(a=>a.action==='paste'&&a.scope==='editor').length,1);
  }
});
test('text checkpoint cannot be rebound to a different delivery account target root or original chat header',async t=>{
  for(const kind of ['job','account','target','root','thread','header','step-binding']){
    const f=await pastedSharedFixture(t),job={...f.job,index:5};await f.driver.releaseTextFocus();f.setRevision(1);
    if(kind==='job')job.id='4'.repeat(64);if(kind==='account')job.account='wxid_other';if(kind==='target')job.target='wxid_other';if(kind==='header')f.setHeader('2'.repeat(64));if(kind==='step-binding')f.driver.textResume.stepBinding.deliveryId='4'.repeat(64);
    const request=f.driver.client.request;f.driver.client.request=async(action,input)=>{const result=await request(action,input);if(action==='capture'){if(kind==='root')result.binding.hwnd='101';if(kind==='thread')result.binding.threadId++;}return result;};
    const before=f.actions.length;let value;try{value=await f.driver.prepare(job,{interactionPlan:{executionMode:'focus-handoff'}});}catch{}assert.notEqual(value?.ready,true,kind);
    assert.equal(f.actions.slice(before).some(a=>['resumeTextEnterProof','readDraft','paste','click','chord','searchEnter'].includes(a.action)),false,kind);
  }
});
test('resuming a saved text step refuses missing native checkpoint or invalid fresh frame without fallback copy or send',async t=>{
  for(const kind of ['missing-native','wrong-header','wrong-proof','revision','missing-frame']){
    const f=await pastedSharedFixture(t),job={...f.job,index:5};await f.driver.releaseTextFocus();f.setRevision(1);const request=f.driver.client.request;
    f.driver.client.request=async(action,input)=>{if(action==='resumeTextEnterProof'&&kind==='missing-native'){f.actions.push({action,...input});throw Object.assign(Error('checkpoint gone'),{code:'QT_TEXT_ENTER_PROOF_REQUIRED',attempted:false});}const result=await request(action,input);if(action==='resumeTextEnterProof'){if(kind==='wrong-header')result.postPasteFrame.regions[0].rgbaSha256='1'.repeat(64);if(kind==='wrong-proof')result.textEnterProof.textSha256='1'.repeat(64);if(kind==='revision')result.revision++;if(kind==='missing-frame')delete result.postPasteFrame;}return result;};
    const before=f.actions.length;let value;try{value=await f.driver.prepare(job,{interactionPlan:{executionMode:'focus-handoff'}});}catch{}assert.notEqual(value?.ready,true,kind);
    assert.equal(f.actions.slice(before).filter(a=>a.action==='resumeTextEnterProof').length,1);assert.equal(f.actions.slice(before).some(a=>['readDraft','paste','click','chord','searchEnter','submitTextEnter'].includes(a.action)),false,kind);
  }
});
test('an actually attempted or uncertain text Enter can never reuse a completed-paste checkpoint',async t=>{
  for(const kind of ['unknown','accepted']){
    const f=await pastedSharedFixture(t),job={...f.job,index:5},ready=await f.driver.observe(job);
    if(kind==='unknown')f.setFailure('submitTextEnter','QT_HUMAN_ACTIVITY_CHANGED',{attempted:true});
    const submit=f.driver.submit(job,{expectedDraft:f.driver.current.draft,editorToken:ready.editorToken,activityRevision:ready.activityRevision},{canSubmit:()=>true});
    if(kind==='unknown')await assert.rejects(submit);else assert.equal((await submit).performed,true);
    await f.driver.releaseTextFocus();f.setFailure(null);f.setRevision(1);const before=f.actions.length;
    await assert.rejects(f.driver.prepare(job,{interactionPlan:{executionMode:'focus-handoff'}}),{code:'UI_QT_TEXT_SUBMIT_UNCERTAIN'});
    assert.equal(f.actions.slice(before).some(a=>['resumeTextEnterProof','readDraft','paste','click','chord','searchEnter','submitTextEnter'].includes(a.action)),false);
  }
});
test('an unknown paste without an applied-input checkpoint never copies or repeats the pending text',async t=>{
  for(const contents of ['','正文','人工更改']){
    const f=fixture(t,withObservedPopups);await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}});const original=structuredClone(f.driver.current);
    f.driver.sharedDraftResume=original;await f.driver.releaseTextFocus();f.driver.textResume=null;f.setRevision(1);f.setDraft(contents);f.setEditor(contents?'f'.repeat(64):'e'.repeat(64));
    const job={...f.job,pendingInput:{text:'正文',count:2}},pending=structuredClone(job.pendingInput),before=f.actions.length;
    await assert.rejects(f.driver.prepare(job,{interactionPlan:{executionMode:'focus-handoff'}}),{code:'UI_QT_TEXT_STEP_UNAVAILABLE'});assert.deepEqual(job.pendingInput,pending);
    assert.equal(f.actions.slice(before).some(a=>a.action==='searchEnter'||a.action==='paste'||a.action==='chord'||a.action==='click'),false);
    assert.equal(f.actions.slice(before).filter(a=>a.action==='readDraft').length,0);
  }
});
test('partial shared draft recovery never navigates after job account target root or header changes',async t=>{
  for(const kind of ['job','account','target','root','header','geometry']){
    const f=fixture(t,withObservedPopups);await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}});f.driver.current.draft='已输入';f.driver.sharedDraftResume=structuredClone(f.driver.current);await f.driver.releaseTextFocus();f.driver.textResume=null;f.setRevision(1);f.setDraft('已输入');
    const job={...f.job,index:1},request=f.driver.client.request;
    if(kind==='job')job.id='4'.repeat(64);if(kind==='account')job.account='wxid_other';if(kind==='target')job.target='wxid_other';if(kind==='header')f.setHeader('a'.repeat(64));
    f.driver.client.request=async(action,input)=>{const result=await request(action,input);if(action==='capture'&&input.surface==='main'){if(kind==='root')result.binding.hwnd='999';if(kind==='geometry')result.binding.captureRect={...result.binding.captureRect,left:11};}return result;};
    const before=f.actions.length;let result;try{result=await f.driver.prepare(job,{interactionPlan:{executionMode:'focus-handoff'}});}catch{}assert.notEqual(result?.ready,true,kind);
    assert.equal(f.actions.slice(before).some(a=>['click','paste','searchEnter','readDraft','chord'].includes(a.action)),false,kind);
  }
});
test('ordinary non-shared draft reads retain CRLF and lone CR normalization',async t=>{
  for(const draft of ['第一行\r\n第二行','第一行\r第二行']){
    const f=fixture(t);await f.driver.prepare(f.job);f.setDraft(draft);f.setEditor('f'.repeat(64));
    const before=f.actions.length,verified=await f.driver.readDraft(f.job);assert.equal(verified.draft,'第一行\n第二行');assert.equal(f.actions.slice(before).filter(a=>a.action==='readDraft').length,1);assert.equal(f.actions.some(a=>a.action==='submitTextEnter'),false);
  }
});

function searchHeight(frame,height){
  const p=frame.popup;p.clientRect.bottom=height;p.clientRectInRoot.bottom=p.clientRectInRoot.top+height;p.windowRect.bottom=p.windowRect.top+height;
  if(frame.regions.length===1)frame.regions[0].rect.bottom=frame.regions[0].rect.top+height;
  return frame;
}
test('the observed 400-height plateau followed by 483-height pixels yields only the final quiet source and exact reopen',async t=>{
  // Combine the observed early first-open plateau and later reopen progression;
  // the already-closed first opening's future was not observed. All identities,
  // image contents and hashes here are synthetic fixture values.
  const sequence=[[0,400,'a'],[63,400,'a'],[91,400,'a'],[119,483,'b'],[183,483,'c'],[251,483,'c'],[309,483,'c']];
  const f=await searchReadinessFixture(t),request=f.driver.client.request;let tick=0,reads=0;
  f.driver.now=()=>tick;f.driver.wait=async ms=>{tick+=ms;};
  f.driver.client.request=async(action,input)=>{const frame=await request(action,input);if(action==='capture'&&input.surface==='observed-search'){
    const [at,height,pixels]=sequence[Math.min(reads++,sequence.length-1)];tick=Math.max(tick,at);searchHeight(frame,height);frame.regions[0].rgbaSha256=pixels.repeat(64);
  }return frame;};
  await f.driver.waitForStableSearchResults(f.baseline);assert.equal(reads,7);assert.equal(tick,309);
  const source=await f.driver.captureSearchSourceAndClose(f.baseline);assert.equal(source.popup.clientRect.bottom,483);assert.equal(source.regions[0].rgbaSha256,'c'.repeat(64));
  assert.equal(f.actions.filter(a=>a.action==='chord').length,1);assert.equal(f.actions.some(a=>a.action==='paste'||a.action==='click'),false);
  const reopened=await searchReadinessFixture(t),reopenRequest=reopened.driver.client.request;let reopenedAt=0,reopenReads=0;
  reopened.driver.now=()=>reopenedAt;reopened.driver.wait=async ms=>{reopenedAt+=ms;};
  reopened.driver.client.request=async(action,input)=>{const frame=await reopenRequest(action,input);if(action==='capture'){
    const [at,height,pixels]=sequence[Math.min(reopenReads++,sequence.length-1)];reopenedAt=Math.max(reopenedAt,at);searchHeight(frame,height);frame.regions[0].rgbaSha256=pixels.repeat(64);
  }return frame;};
  const matched=await reopened.driver.waitForStableSearchResults(reopened.baseline,{expectedSource:source});
  assert.equal(reopenReads,7);assert.equal(matched.popup.clientRect.bottom,483);assert.equal(matched.regions[0].rgbaSha256,source.regions[0].rgbaSha256);f.driver.discardNativeFrameImage(source);
});
test('whole-popup pixels geometry and recoverable read failures each restart the complete quiet interval',async t=>{
  for(const kind of ['pixels','height','capture-pixels','capture-geometry']){
    const f=await searchReadinessFixture(t),request=f.driver.client.request;let tick=0,reads=0,firstChanged;
    f.driver.now=()=>tick;f.driver.wait=async ms=>{tick+=ms;};
    f.driver.client.request=async(action,input)=>{
      if(action==='capture'){
        reads++;
        if(reads===4&&kind.startsWith('capture-'))throw kind==='capture-pixels'
          ?Object.assign(Error('read changed'),{code:'QT_PIXELS_CHANGED',attempted:false,pixelMismatch:{stage:'capture',anchorIndex:0}})
          :Object.assign(Error('geometry changed'),{code:'QT_POPUP_BINDING_CHANGED',attempted:false});
      }
      const frame=await request(action,input);if(action==='capture'){
        searchHeight(frame,kind==='height'&&reads>=4?483:400);frame.regions[0].rgbaSha256=(kind==='pixels'&&reads>=4?'b':'a').repeat(64);
        if(reads>=4&&firstChanged===undefined)firstChanged=tick;
      }return frame;
    };
    await f.driver.waitForStableSearchResults(f.baseline);assert.ok(tick-firstChanged>=125,kind);assert.equal(reads,kind.startsWith('capture-')?9:8,kind);
    assert.equal(f.actions.every(a=>a.action==='capture'),true);
  }
});
test('a recoverable read failure after an already quiet result cannot reuse its elapsed quiet time',async t=>{
  for(const kind of ['pixels','geometry']){
    const f=await searchReadinessFixture(t),request=f.driver.client.request;let tick=0,failed=false,firstFresh,sourceReads=0;
    f.driver.now=()=>tick;f.driver.wait=async ms=>{tick+=ms;};
    f.driver.client.request=async(action,input)=>{
      if(action==='capture'&&input.image&&++sourceReads===1){failed=true;throw kind==='pixels'
        ?Object.assign(Error('source changed'),{code:'QT_PIXELS_CHANGED',attempted:false,pixelMismatch:{stage:'capture',anchorIndex:0}})
        :Object.assign(Error('source growth'),{code:'QT_POPUP_BINDING_CHANGED',attempted:false});}
      const frame=await request(action,input);if(failed&&action==='capture'&&input.surface==='observed-search'&&firstFresh===undefined)firstFresh=tick;return frame;
    };
    await f.driver.waitForStableSearchResults(f.baseline);assert.equal(tick,140);const source=await f.driver.captureSearchSourceAndClose(f.baseline);
    assert.ok(tick-firstFresh>=125,kind);assert.equal(sourceReads,2);assert.equal(f.actions.filter(a=>a.action==='chord').length,1);f.driver.discardNativeFrameImage(source);
  }
});
test('a different larger search result can remain quiet without ever satisfying the original smaller source',async t=>{
  const f=await searchReadinessFixture(t),request=f.driver.client.request;let tick=0,reads=0;
  const expected=searchHeight(structuredClone(f.driver.frame),400);expected.regions[0].rgbaSha256='a'.repeat(64);
  f.driver.now=()=>tick;f.driver.wait=async ms=>{tick+=ms;};
  f.driver.client.request=async(action,input)=>{const frame=await request(action,input);if(action==='capture'){reads++;searchHeight(frame,483);frame.regions[0].rgbaSha256='b'.repeat(64);}return frame;};
  await assert.rejects(f.driver.waitForStableSearchResults(f.baseline,{expectedSource:expected}),{code:'UI_QT_SEARCH_RESULTS_UNSTABLE'});
  assert.ok(tick>=125&&tick<=600);assert.equal(reads,16);assert.equal(f.actions.every(a=>a.action==='capture'),true);
});
test('the measured search readiness and PNG durations fit one 600 ms budget without waiting the full allowance',async t=>{
  // Measured native capture and scheduler durations from one complete opening;
  // actual identities and image contents are replaced by synthetic fixtures.
  const costs=[18,14,16,16,19,14,18,32],waitCosts=[41,47,46,46,45,49],phases=['a','a','b','c','c','c','c','c'];
  const f=await searchReadinessFixture(t),request=f.driver.client.request;let tick=0,reads=0,waits=0,escapedAt;
  f.driver.now=()=>tick;f.driver.wait=async ms=>{tick+=waitCosts[waits++]??ms;};
  f.driver.client.request=async(action,input)=>{
    if(action==='chord')escapedAt=tick;
    const frame=await request(action,input);if(action==='capture'&&input.surface==='observed-search'){
      const index=reads++;tick+=costs[index];searchHeight(frame,index<2?400:483);frame.regions[0].rgbaSha256=phases[index].repeat(64);
    }return frame;
  };
  await f.driver.waitForStableSearchResults(f.baseline);assert.equal(tick,389);assert.equal(reads,7);
  const source=await f.driver.captureSearchSourceAndClose(f.baseline);assert.equal(escapedAt,421);assert.equal(reads,8);
  assert.equal(source.popup.clientRect.bottom,483);assert.equal(source.regions[0].rgbaSha256,'c'.repeat(64));assert.equal(f.actions.filter(a=>a.action==='chord').length,1);
  assert.equal(f.actions.some(a=>a.action==='paste'||a.action==='click'),false);f.driver.discardNativeFrameImage(source);
});
test('search expiry during final source processing cannot authorize Escape after the 600 ms deadline',async t=>{
  const f=await searchReadinessFixture(t),matches=f.driver.searchReadinessFrameMatches.bind(f.driver),request=f.driver.client.request,files=[];let tick=0;
  f.driver.now=()=>tick;f.driver.wait=async ms=>{tick+=ms;};
  f.driver.client.request=async(action,input)=>{const frame=await request(action,input);if(frame.image)files.push(frame.image.file);return frame;};
  f.driver.searchReadinessFrameMatches=(before,after)=>{const equal=matches(before,after);if(after?.image)tick=601;return equal;};
  await f.driver.waitForStableSearchResults(f.baseline);
  await assert.rejects(f.driver.captureSearchSourceAndClose(f.baseline),{code:'UI_QT_SEARCH_RESULTS_UNSTABLE'});
  assert.equal(f.actions.some(a=>a.action==='chord'||a.action==='paste'||a.action==='click'),false);assert.equal(files.length,1);assert.equal(fs.existsSync(files[0]),false);
});
function searchFrameGuardFailure(changes={}){
  const diagnostic={version:1,stage:'frame',pasteStage:'none',kind:'search',inputAttempted:false,readOnly:true,authorizationGranted:false,observationAfterFailure:true,observed:true,revisionUnchangedBefore:true,revisionUnchangedAfter:true,foregroundIsRoot:true,foregroundIsPopup:false,enumerationComplete:false,elapsedMs:0,
    boundWindowRectInRoot:r(60,65,460,185),boundClientRect:r(0,0,400,120),boundClientRectInRoot:r(60,65,460,185),frameWindowRectInRoot:r(60,65,460,465),frameClientRect:r(0,0,400,400),
    boundNow:{available:false,sameBoundWindow:true,previouslyVisible:false},visibleCandidates:[]};
  return Object.assign(Error('guard'),{code:'QT_POPUP_BINDING_CHANGED',attempted:false,popupBindingMismatch:diagnostic},changes);
}
test('preauthorization search height may settle 120 to 400 to 483 only inside the original fixed-width native bounds',async t=>{
  const f=await searchReadinessFixture(t),request=f.driver.client.request,heights=[120,400,483,483];let reads=0;
  f.driver.client.request=async(action,input)=>{const result=await request(action,input);if(action==='capture'){searchHeight(result,heights[Math.min(reads++,heights.length-1)]);result.regions[0].rgbaSha256=(reads<3?'a':'b').repeat(64);}return result;};
  const result=await f.driver.waitForStableSearchResults(f.baseline);assert.equal(result.popup.clientRect.bottom,483);assert.equal(reads,7);assert.equal(f.actions.every(a=>a.action==='capture'),true);
  for(const mutate of [frame=>searchHeight(frame,600),frame=>{searchHeight(frame,200);frame.popup.windowRect.bottom++;},frame=>{searchHeight(frame,200);for(const key of ['clientRect','clientRectInRoot','windowRect'])frame.popup[key].right++;frame.regions[0].rect.right++;},frame=>{searchHeight(frame,200);frame.popup.windowRect.top++;frame.popup.windowRect.bottom++;}]){
    const bad=await searchReadinessFixture(t),original=bad.driver.client.request;let count=0;bad.driver.client.request=async(a,v)=>{const result=await original(a,v);if(a==='capture'&&++count===2)mutate(result);return result;};
    await assert.rejects(bad.driver.waitForStableSearchResults(bad.baseline));assert.equal(count,2);
  }
});
test('a read-only capture geometry refusal without diagnostics may only reobserve from an existing complete original binding',async t=>{
  const f=await searchReadinessFixture(t),request=f.driver.client.request;let reads=0;
  f.driver.client.request=async(action,input)=>{
    if(action==='capture'&&++reads===2)throw Object.assign(Error('capturing growth'),{code:'QT_POPUP_BINDING_CHANGED',attempted:false});
    const result=await request(action,input);if(action==='capture')searchHeight(result,reads===1?400:483);return result;
  };
  const current=await f.driver.waitForStableSearchResults(f.baseline);assert.equal(reads,7);assert.equal(current.popup.clientRect.bottom,483);assert.equal(f.actions.every(a=>a.action==='capture'),true);
  for(const kind of ['no-baseline','attempted','unknown','diagnostic','new-popup','root','thread','epoch','revision','position','width','owner','outside']){
    const bad=await searchReadinessFixture(t),original=bad.driver.client.request;let count=0;
    bad.driver.client.request=async(action,input)=>{
      if(action==='capture'){
        count++;if(count===(kind==='no-baseline'?1:2)){
          const error=Object.assign(Error('capture refusal'),{code:'QT_POPUP_BINDING_CHANGED',attempted:false});
          if(kind==='attempted')error.attempted=true;if(kind==='unknown')delete error.attempted;if(kind==='diagnostic')error.popupBindingMismatch=searchFrameGuardFailure().popupBindingMismatch;throw error;
        }
      }
      const result=await original(action,input);
      if(action==='capture'&&count>=3){
        if(kind==='new-popup')result.popup.hwnd='999';if(kind==='root')result.binding.hwnd='101';if(kind==='thread')result.binding.threadId=99;
        if(kind==='epoch')result.epoch='f'.repeat(32);if(kind==='revision')result.revision++;
        if(kind==='position'){result.popup.windowRect.left++;result.popup.windowRect.right++;}
        if(kind==='width'){result.popup.clientRect.right++;result.popup.clientRectInRoot.right++;result.popup.windowRect.right++;result.regions[0].rect.right++;}
        if(kind==='owner')result.popup.ownerRelation='root-owned';if(kind==='outside')searchHeight(result,600);
      }return result;
    };
    await assert.rejects(bad.driver.waitForStableSearchResults(bad.baseline),undefined,kind);assert.equal(count,kind==='no-baseline'?1:['attempted','unknown','diagnostic'].includes(kind)?2:3,kind);assert.equal(bad.actions.every(a=>a.action==='capture'),true);
  }
});
test('capture-geometry recovery shares the original timeout and can replace a source observation without repeating Escape',async t=>{
  const f=await searchReadinessFixture(t),request=f.driver.client.request;let sourceAttempts=0,escapes=0,height=400;
  f.driver.client.request=async(action,input)=>{
    if(action==='chord')escapes++;
    if(action==='capture'&&input.image&&++sourceAttempts===1){height=483;throw Object.assign(Error('growth during PNG'),{code:'QT_POPUP_BINDING_CHANGED',attempted:false});}
    const result=await request(action,input);if(action==='capture'&&input.surface==='observed-search')searchHeight(result,height);return result;
  };
  await f.driver.waitForStableSearchResults(f.baseline);const source=await f.driver.captureSearchSourceAndClose(f.baseline);
  assert.equal(sourceAttempts,2);assert.equal(escapes,1);assert.equal(source.popup.clientRect.bottom,483);f.driver.discardNativeFrameImage(source);
  const timed=await searchReadinessFixture(t),original=timed.driver.client.request;let tick=0,reads=0;
  timed.driver.now=()=>tick;timed.driver.wait=async ms=>{tick+=ms;};timed.driver.client.request=async(action,input)=>{
    if(action==='capture'&&++reads>1){tick+=110;throw Object.assign(Error('never stable'),{code:'QT_POPUP_BINDING_CHANGED',attempted:false});}return original(action,input);
  };
  await assert.rejects(timed.driver.waitForStableSearchResults(timed.baseline),{code:'UI_QT_SEARCH_RESULTS_UNSTABLE'});assert.ok(reads<=6);assert.ok(tick<=635);assert.equal(timed.actions.some(a=>a.action==='chord'||a.action==='paste'),false);
});
test('late search height change before Escape discards the old PNG and reobserves before one actual closing input',async t=>{
  const f=await searchReadinessFixture(t),request=f.driver.client.request,images=[];let height=400,guards=0,accepted=0,recoveredReads=0;
  f.driver.client.request=async(action,input)=>{
    if(action==='chord'){
      guards++;if(guards===1){height=483;throw searchFrameGuardFailure();}accepted++;
    }
    const result=await request(action,input);
    if(action==='capture'&&input.surface==='observed-search'){
      if(guards===1){recoveredReads++;assert.equal(fs.existsSync(images[0]),false);}
      searchHeight(result,height);result.regions[0].rgbaSha256=(height===400?'a':'b').repeat(64);if(result.image)images.push(result.image.file);
    }
    return result;
  };
  await f.driver.waitForStableSearchResults(f.baseline);const source=await f.driver.captureSearchSourceAndClose(f.baseline);
  assert.equal(source.popup.clientRect.bottom,483);assert.equal(source.regions[0].rgbaSha256,'b'.repeat(64));assert.equal(guards,2);assert.equal(accepted,1);assert.equal(recoveredReads,6);
  assert.equal(images.length,2);assert.equal(fs.existsSync(images[0]),false);assert.equal(fs.existsSync(images[1]),true);assert.equal(source.image.file,images[1]);assert.equal(f.driver.surface,'main');
  assert.equal(f.actions.some(a=>a.action==='paste'||a.action==='click'),false);f.driver.discardNativeFrameImage(source);
});
test('search source recovery cannot use incomplete diagnostics as identity or retry attempted and unknown input',async t=>{
  for(const kind of ['attempted','unknown','diagnostic-attempted','no-diagnostic','active-stage','wrong-code','new-popup','new-root','activity','owner','out-of-bounds']){
    const f=await searchReadinessFixture(t),request=f.driver.client.request;let guards=0,afterFailureReads=0,sourceFile;
    f.driver.client.request=async(action,input)=>{
      if(action==='chord'){
        guards++;const error=searchFrameGuardFailure();
        if(kind==='attempted')error.attempted=true;if(kind==='unknown')delete error.attempted;if(kind==='diagnostic-attempted')error.popupBindingMismatch.inputAttempted=true;if(kind==='no-diagnostic')delete error.popupBindingMismatch;if(kind==='active-stage')error.popupBindingMismatch.stage='active';if(kind==='wrong-code')error.code='QT_PIXELS_CHANGED';throw error;
      }
      const result=await request(action,input);
      if(action==='capture'&&input.surface==='observed-search'){
        if(result.image)sourceFile=result.image.file;
        if(guards){afterFailureReads++;assert.equal(fs.existsSync(sourceFile),false);if(kind==='new-popup')result.popup.hwnd='999';if(kind==='new-root')result.binding.hwnd='101';if(kind==='activity')result.revision++;if(kind==='owner')result.popup.ownerRelation='root-owned';if(kind==='out-of-bounds')searchHeight(result,600);}
      }
      return result;
    };
    await f.driver.waitForStableSearchResults(f.baseline);await assert.rejects(f.driver.captureSearchSourceAndClose(f.baseline),undefined,kind);
    assert.equal(guards,1,kind);assert.equal(afterFailureReads,['new-popup','new-root','activity','owner','out-of-bounds'].includes(kind)?1:0,kind);assert.equal(fs.existsSync(sourceFile),false);
  }
});
test('one post-paste budget includes initial readiness source PNG and unattempted guard recovery, but never retries a completed Escape',async t=>{
  const f=await searchReadinessFixture(t),request=f.driver.client.request;let tick=0,guards=0,reads=0;const images=[];
  f.driver.now=()=>tick;f.driver.wait=async ms=>{tick+=ms;};f.driver.client.request=async(action,input)=>{
    if(action==='chord'){guards++;tick+=500;throw searchFrameGuardFailure();}
    const result=await request(action,input);if(action==='capture'){reads++;tick+=30;if(result.image)images.push(result.image.file);}return result;
  };
  await f.driver.waitForStableSearchResults(f.baseline);await assert.rejects(f.driver.captureSearchSourceAndClose(f.baseline),{code:'UI_QT_SEARCH_RESULTS_UNSTABLE'});
  assert.equal(guards,1);assert.equal(reads,4);assert.equal(images.every(file=>!fs.existsSync(file)),true);
  const completed=await searchReadinessFixture(t),original=completed.driver.client.request;let escapes=0;
  completed.driver.client.request=async(action,input)=>{if(action==='chord')escapes++;if(action==='capture'&&input.surface==='main')throw searchFrameGuardFailure();return original(action,input);};
  await completed.driver.waitForStableSearchResults(completed.baseline);await assert.rejects(completed.driver.captureSearchSourceAndClose(completed.baseline),{code:'QT_POPUP_BINDING_CHANGED'});assert.equal(escapes,1);
});
test('reopened search waits for the complete original source geometry and pixels rather than an earlier stable plateau',async t=>{
  const f=await searchReadinessFixture(t),request=f.driver.client.request;let reads=0;
  const expected=searchHeight(structuredClone(f.driver.frame),483);expected.regions[0].rgbaSha256='e'.repeat(64);
  f.driver.client.request=async(action,input)=>{const result=await request(action,input);if(action==='capture'){const index=++reads;searchHeight(result,index<=2?400:483);result.regions[0].rgbaSha256=(index<=4?'d':'e').repeat(64);}return result;};
  const current=await f.driver.waitForStableSearchResults(f.baseline,{expectedSource:expected});assert.equal(reads,9);assert.equal(current.regions[0].rgbaSha256,expected.regions[0].rgbaSha256);assert.equal(current.popup.clientRect.bottom,483);
});
test('source PNG changed during capture is replaced before Escape and late PNG completion cannot create input authority',async t=>{
  for(const timeout of [false,true]){
    const f=await searchReadinessFixture(t),request=f.driver.client.request,files=[];let tick=0,height=400,escapes=0;
    f.driver.now=()=>tick;f.driver.wait=async ms=>{tick+=ms;};
    f.driver.client.request=async(action,input)=>{if(action==='chord')escapes++;const result=await request(action,input);
      if(action==='capture'&&input.surface==='observed-search'){
        if(input.image){height=483;files.push(result.image.file);if(timeout)tick+=600;}
        searchHeight(result,height);
      }return result;
    };
    await f.driver.waitForStableSearchResults(f.baseline);
    if(timeout){await assert.rejects(f.driver.captureSearchSourceAndClose(f.baseline),{code:'UI_QT_SEARCH_RESULTS_UNSTABLE'});assert.equal(escapes,0);assert.equal(files.length,1);}
    else{const source=await f.driver.captureSearchSourceAndClose(f.baseline);assert.equal(source.popup.clientRect.bottom,483);assert.equal(escapes,1);assert.equal(files.length,2);assert.equal(fs.existsSync(files[0]),false);f.driver.discardNativeFrameImage(source);}
    assert.equal(files.every(file=>!fs.existsSync(file)),true);
  }
});

test('panel close observes whole native editor frames until stable without repeating a click',async t=>{
  const f=await panelClosedFixture(t),request=f.driver.client.request,phases=['a','b','e','e'];let tick=0,waited=0,reads=0;
  f.driver.now=()=>tick;f.driver.wait=async ms=>{assert.equal(ms,35);tick+=ms;waited+=ms;};
  f.driver.client.request=async(action,input)=>{if(action==='capture')f.setEditor(phases[reads++].repeat(64));tick+=15;return request(action,input);};
  const result=await f.driver.captureStablePanelClosed(f.baseline);assert.equal(reads,4);assert.equal(waited,105);assert.equal(result.regions[1].rgbaSha256,'e'.repeat(64));
  assert.equal(f.actions.every(a=>a.action==='capture'),true);assert.equal(fs.existsSync(result.image.file),true);
  assert.equal(fs.readdirSync(path.dirname(result.image.file)).length,2);f.driver.discardNativeFrameImage(result);
});
test('panel close only retries explicitly unattempted editor capture pixels and preserves identity/activity/header',async t=>{
  for(const kind of ['retry','attempted','guard','header','focus','binding','activity']){
    const f=await panelClosedFixture(t),request=f.driver.client.request;let reads=0;
    f.driver.client.request=async(action,input)=>{if(action==='capture'&&++reads===1){
      if(['retry','attempted','guard'].includes(kind))throw Object.assign(Error('changed'),{code:'QT_PIXELS_CHANGED',attempted:kind==='attempted',pixelMismatch:{stage:kind==='guard'?'guard':'capture',anchorIndex:1}});
      if(kind==='header')f.setHeader('a'.repeat(64));if(kind==='activity')f.setRevision(1);if(kind==='focus')throw Object.assign(Error('focus'),{code:'DRAFT_WINDOW_NOT_FOREGROUND',attempted:false});
    }const value=await request(action,input);if(action==='capture'&&kind==='binding')value.binding.hwnd='101';return value;};
    if(kind==='retry'){const result=await f.driver.captureStablePanelClosed(f.baseline);assert.equal(reads,3);f.driver.discardNativeFrameImage(result);}
    else{await assert.rejects(f.driver.captureStablePanelClosed(f.baseline));assert.equal(reads,1);}
    assert.equal(f.actions.some(a=>a.action==='click'),false);
  }
});
test('panel close never exceeds its read-only observation budget or accepts one final frame',async t=>{
  const f=await panelClosedFixture(t),request=f.driver.client.request;let tick=0,reads=0;
  f.driver.now=()=>tick;f.driver.wait=async ms=>{tick+=ms;};f.driver.client.request=async(action,input)=>{if(action==='capture'){tick+=40;f.setEditor((++reads%2?'a':'b').repeat(64));}return request(action,input);};
  await assert.rejects(f.driver.captureStablePanelClosed(f.baseline),{code:'UI_QT_CONTACT_PANEL_CLOSE_UNVERIFIED'});assert.ok(reads<=6);assert.ok(tick<=440);assert.equal(f.actions.some(a=>a.action==='click'),false);
});
test('closed panel admits only actually observed canonical-equal caret phases, retaining later native draft permission',async t=>{
  const f=await panelClosedFixture(t),inspect=f.driver.inspectPanelEditor;
  f.driver.inspectPanelEditor=async input=>{const proof=await inspect(input);return{...proof,canonicalEditorSha256:'e'.repeat(64),caretCandidate:proof.editorRgbaSha256!=='e'.repeat(64)};};
  f.setEditor('f'.repeat(64));await f.driver.verifyObservedPanelClosed(f.baseline,{park:false});
  f.setEditor('e'.repeat(64));assert.equal(f.driver.panelClosedFrameMatches(f.baseline,await f.driver.capture(['header','editor'])),true);
  f.setEditor('f'.repeat(64));assert.equal(f.driver.panelClosedFrameMatches(f.baseline,await f.driver.capture(['header','editor'])),true);
  f.setEditor('a'.repeat(64));assert.equal(f.driver.panelClosedFrameMatches(f.baseline,await f.driver.capture(['header','editor'])),false);
  assert.equal(f.driver.current,null);assert.equal(f.actions.some(a=>['readDraft','paste','type','click'].includes(a.action)),false);
});
test('panel canonical comparison cannot authorize animation, changed text, missing original source or invalid proof metadata',async t=>{
  for(const kind of ['different','partial','image','pixels','canonical','authorized','identity','count','missing']){
    const f=await panelClosedFixture(t),inspect=f.driver.inspectPanelEditor;f.setEditor('f'.repeat(64));
    f.driver.inspectPanelEditor=async input=>{const proof=await inspect(input);if(kind==='partial')throw Object.assign(Error('animation'),{code:'UI_QT_LAYOUT_EDITOR_CORNER_UNCERTAIN'});
      if(kind==='image')proof.imageSha256='0'.repeat(64);if(kind==='pixels')proof.editorRgbaSha256='a'.repeat(64);if(kind==='canonical')proof.canonicalEditorSha256='short';if(kind==='authorized')proof.emptyDraftAuthorized=true;if(kind==='identity')proof.identityVerified=true;if(kind==='count')proof.extra=true;return proof;};
    if(kind==='missing')f.driver.discardNativeFrameImage(f.baseline);
    await assert.rejects(f.driver.verifyObservedPanelClosed(f.baseline,{park:false}));assert.equal(f.driver.panelEditorProofs?.has(f.baseline)??false,false);
    assert.equal(f.actions.some(a=>a.action==='click'),false);
  }
});

async function selfCloseFixture(t){
  const f=fixture(t,withObservedPopups);f.driver.config.settleMs=250;
  const baseline=await f.driver.capture(['header']);f.driver.transaction={epoch:baseline.epoch,revision:baseline.revision,pid:baseline.binding.pid,created:baseline.binding.processCreatedFileTimeUtc};
  f.driver.voiceFocusLease={parked:false};f.driver.surface='self';await f.driver.capture([]);f.actions.length=0;
  return{...f,baseline,close:()=>f.driver.closeObservedSelfProfile(baseline)};
}
test('observed self close replaces only its fixed wait with two native full header/editor proofs',async t=>{
  const f=await selfCloseFixture(t),waits=[];let now=0;f.driver.now=()=>now;f.driver.wait=async ms=>{waits.push(ms);now+=ms;};
  const request=f.driver.client.request;f.driver.client.request=async(action,values)=>{now+=action==='capture'?20:8;return request(action,values);};
  const transaction=structuredClone(f.driver.transaction),frame=await f.close();
  assert.deepEqual(f.actions.map(x=>x.action),['capture','chord','capture','capture']);assert.deepEqual(waits,[35]);assert.equal(now,103);
  assert.deepEqual(f.actions.filter(x=>x.action==='capture'&&x.surface==='main').map(x=>x.regions),Array(2).fill([f.driver.config.layout.header,f.driver.config.layout.editor]));
  assert.equal(f.actions[1].key,'Escape');assert.equal(f.actions[1].token,f.actions[0].token??'1'.repeat(32));assert.equal(f.driver.frame,frame);assert.deepEqual(f.driver.transaction,transaction);assert.equal(f.driver.surface,'main');
  await assert.rejects(f.close(),{code:'UI_QT_OBSERVATION_INVALID'});assert.equal(f.actions.filter(x=>x.action==='chord').length,1);
});

for(const [label,change,code] of [
  ['header',frame=>frame.regions[0].rgbaSha256='f'.repeat(64),'UI_QT_HEADER_CHANGED'],
  ['editor',frame=>frame.regions[1].rgbaSha256='f'.repeat(64),'UI_QT_PROFILE_CLOSE_UNVERIFIED'],
  ['epoch',frame=>frame.epoch='3'.repeat(32),'UI_QT_HUMAN_ACTIVITY_CHANGED'],
  ['revision',frame=>frame.revision++,'UI_QT_HUMAN_ACTIVITY_CHANGED'],
  ['PID',frame=>frame.binding.pid++,'UI_QT_HUMAN_ACTIVITY_CHANGED'],
  ['creation',frame=>frame.binding.processCreatedFileTimeUtc='12346','UI_QT_HUMAN_ACTIVITY_CHANGED'],
  ['HWND',frame=>frame.binding.hwnd='101','UI_QT_OBSERVATION_INVALID'],
  ['DPI',frame=>frame.binding.dpi=120,'UI_QT_OBSERVATION_INVALID'],
  ['geometry',frame=>frame.binding.captureRect={...frame.binding.captureRect,left:11},'UI_QT_OBSERVATION_CHANGED'],
  ['recent activity',frame=>frame.idleMs=999,'UI_USER_ACTIVE'],
  ['cropped editor',frame=>frame.regions[1]={...frame.regions[1],rect:{...frame.regions[1].rect,left:301}},'UI_QT_OBSERVATION_INVALID'],
])test(`self close refuses ${label} changes without repeating Escape`,async t=>{
  const f=await selfCloseFixture(t),request=f.driver.client.request;let samples=0;
  f.driver.client.request=async(action,values)=>{const result=await request(action,values);if(action==='capture'&&values.surface==='main'&&++samples===2)change(result);return result;};
  await assert.rejects(f.close(),{code});assert.equal(f.actions.filter(x=>x.action==='chord').length,1);assert.equal(samples,2);assert.equal(f.driver.surface,'main');
});
test('self close stops on the first failed capture and unknown key result with no cleanup key retry',async t=>{
  for(const mode of ['capture','chord','unconfirmed']){
    const f=await selfCloseFixture(t),request=f.driver.client.request;let captures=0;
    f.driver.client.request=async(action,values)=>{if(action==='capture'&&values.surface==='main'){captures++;if(mode==='capture')throw Object.assign(Error('refusal'),{code:'QT_PIXELS_CHANGED',attempted:false});}if(action==='chord'&&mode==='chord')throw Object.assign(Error('refusal'),{code:'QT_POPUP_BINDING_CHANGED',attempted:true});const result=await request(action,values);if(action==='chord'&&mode==='unconfirmed')delete result.performed;return result;};
    await assert.rejects(f.close(),{code:mode==='capture'?'QT_PIXELS_CHANGED':mode==='chord'?'QT_POPUP_BINDING_CHANGED':'UI_QT_PROFILE_CLOSE_UNVERIFIED'});
    const before=f.actions.length;assert.deepEqual(await f.driver.closePreparationPopupAfterFailure(),{attempted:false,closed:false});assert.equal(f.actions.length,before);assert.equal(captures,mode==='capture'?1:0);
  }
});
test('self close readiness is bounded and cancellation between proofs causes no further input',async t=>{
  for(const mode of ['deadline','cancel']){
    const f=await selfCloseFixture(t),request=f.driver.client.request,controller=new AbortController();let time=0,samples=0;f.driver.now=()=>time;f.driver.operationSignal=controller.signal;
    f.driver.client.request=async(action,values)=>{const result=await request(action,values);if(action==='capture'&&values.surface==='main'){samples++;time+=200;}return result;};
    f.driver.wait=async ms=>{time+=ms;if(mode==='cancel')controller.abort();};
    await assert.rejects(f.close(),{code:mode==='cancel'?'UI_QT_CANCELLED':'UI_QT_PROFILE_CLOSE_UNVERIFIED'});assert.equal(f.actions.filter(x=>x.action==='chord').length,1);assert.equal(samples,mode==='cancel'?1:2);
  }
});
test('self close waits only for asynchronous main activation then requires two new complete frames',async t=>{
  const f=await selfCloseFixture(t),request=f.driver.client.request,waits=[];let samples=0,time=0;
  f.driver.now=()=>time;f.driver.wait=async ms=>{waits.push(ms);time+=ms;};
  f.driver.client.request=async(action,values)=>{if(action==='capture'&&values.surface==='main'&&[1,3].includes(++samples))throw Object.assign(Error('activation pending'),{code:'DRAFT_WINDOW_NOT_FOREGROUND',attempted:false});return request(action,values);};
  const transaction=structuredClone(f.driver.transaction);await f.close();assert.equal(samples,5);assert.deepEqual(waits,[35,35,35,35]);assert.equal(f.actions.filter(x=>x.action==='chord').length,1);assert.deepEqual(f.driver.transaction,transaction);
});
test('self close focus observation retry cannot retry attempted or unspecified failures or accept a new epoch',async t=>{
  for(const mode of ['attempted','unknown','activity','new-epoch']){
    const f=await selfCloseFixture(t),request=f.driver.client.request;let samples=0;
    f.driver.client.request=async(action,values)=>{if(action==='capture'&&values.surface==='main'){
      samples++;if(samples===1)throw Object.assign(Error('refused'),{code:mode==='activity'?'QT_HUMAN_ACTIVITY_CHANGED':'DRAFT_WINDOW_NOT_FOREGROUND',...(mode==='unknown'?{}:{attempted:mode==='attempted'})});
    }const result=await request(action,values);if(action==='capture'&&values.surface==='main'&&mode==='new-epoch')result.revision++;return result;};
    await assert.rejects(f.close(),{code:mode==='activity'?'QT_HUMAN_ACTIVITY_CHANGED':mode==='new-epoch'?'UI_QT_HUMAN_ACTIVITY_CHANGED':'DRAFT_WINDOW_NOT_FOREGROUND'});assert.equal(samples,mode==='new-epoch'?2:1);assert.equal(f.actions.filter(x=>x.action==='chord').length,1);
  }
});
test('self close missing main activation has a 400 ms bound and never reissues Escape',async t=>{
  const f=await selfCloseFixture(t),request=f.driver.client.request;let samples=0,time=0;f.driver.now=()=>time;f.driver.wait=async ms=>{time+=ms;};
  f.driver.client.request=async(action,values)=>{if(action==='capture'&&values.surface==='main'){samples++;throw Object.assign(Error('pending'),{code:'DRAFT_WINDOW_NOT_FOREGROUND',attempted:false});}return request(action,values);};
  await assert.rejects(f.close(),{code:'DRAFT_WINDOW_NOT_FOREGROUND'});assert.equal(samples,12);assert.equal(time,385);assert.equal(f.actions.filter(x=>x.action==='chord').length,1);
});
test('adaptive preparation uses observed whole popups and exact detected row and panel anchors',async t=>{
  const f=fixture(t,withObservedPopups);f.driver.locateContactPanel=async options=>panelProof(options);
  assert.equal((await f.driver.prepare(f.job,{textEntryMode:'paste'})).ready,true);
  const transitions=f.actions.filter(a=>a.popupTransition);assert.equal(transitions.length,3);
  assert.ok(transitions.every(a=>a.popupTransition.geometryMode==='observed-v1'&&Object.keys(a.popupTransition.calibration).length===7));
  assert.ok(f.actions.some(a=>a.surface==='observed-profile'&&a.regions.length===0));
  const searchClick=f.actions.find(a=>a.action==='click'&&a.rect.top===91);assert.ok(searchClick);assert.deepEqual(searchClick.rect,r(61,91,459,111));
  const member=f.actions.find(a=>a.popupTransition?.id==='profile');assert.deepEqual(member.rect,r(620,100,680,160));
  assert.ok(f.actions.some(a=>a.action==='click'&&a.rect.left===400&&a.rect.top===25));
  assert.equal(fs.readdirSync(path.join(f.driver.root,'state/ui-host/qt-frames')).length,0);
});

test('adaptive profile recognition uses one fixed transform without expected text and keeps full-popup rechecks',async t=>{
  const f=fixture(t,withObservedPopups),original=f.driver.recognize,calls=[];f.driver.locateContactPanel=async options=>panelProof(options);
  f.driver.recognize=async options=>{calls.push(options);return original(options);};
  assert.equal((await f.driver.prepare(f.job,{textEntryMode:'paste'})).ready,true);
  const profiles=calls.filter(options=>options.preprocess!==undefined);
  assert.equal(profiles.length,2);
  for(const options of profiles){assert.equal(options.preprocess,'gray-gamma-1.6');assert.equal(options.model,'small');assert.equal(options.region,undefined);assert.equal(options.expected,undefined);assert.equal(options.expectedId,undefined);}
  assert.equal(f.actions.filter(action=>action.action==='capture'&&action.surface==='observed-profile'&&action.regions.length===0).length,4);
});

test('profile transform cannot repair low confidence, a different ID, changed source, or missing transform binding',async t=>{
  for(const failure of ['confidence','identity','hash','transform','size']){
    const f=fixture(t,withObservedPopups),original=f.driver.recognize;let profileReads=0;
    f.driver.recognize=async options=>{const ocr=await original(options);if(options.preprocess){profileReads++;if(failure==='confidence')ocr.words[0].confidence=.96999;if(failure==='identity')ocr.words[0].text='微信号：other';if(failure==='hash')ocr.imageSha256='f'.repeat(64);if(failure==='transform')delete ocr.preprocess;if(failure==='size')ocr.width++;}return ocr;};
    await assert.rejects(f.driver.prepare(f.job,{textEntryMode:'paste'}),{code:'UI_QT_PROFILE_ID_UNVERIFIED'});
    assert.equal(profileReads,1);assert.equal(f.actions.some(action=>action.key==='Control+F'),false);
  }
});

test('a transformed exact profile identity still requires the unchanged complete popup image',async t=>{
  const f=fixture(t,withObservedPopups),original=f.driver.recognize;
  f.driver.recognize=async options=>{const ocr=await original(options);if(options.preprocess)f.setHeader('a'.repeat(64));return ocr;};
  await assert.rejects(f.driver.prepare(f.job,{textEntryMode:'paste'}),{code:'UI_QT_PROFILE_CHANGED'});
  assert.equal(f.actions.some(action=>action.key==='Control+F'),false);
});

test('adaptive mode refuses missing or stale panel evidence instead of using an old profile member',async t=>{
  for(const kind of ['missing','hash','source','bounds']){const f=fixture(t,c=>{withObservedPopups(c);c.layout.profileMember=r(600,100,660,160);c.layout.profilePanelClose=r(760,80,785,100);});f.driver.locateContactPanel=async options=>{const p=panelProof(options);if(kind==='missing')return null;if(kind==='hash')p.memberRgbaSha256='e'.repeat(64);if(kind==='source')p.imageSha256='b'.repeat(64);if(kind==='bounds')p.memberRect.right=810;return p;};await assert.rejects(f.driver.prepare(f.job,{textEntryMode:'paste'}),{code:kind==='hash'?'UI_QT_CONTACT_PANEL_CHANGED':'UI_QT_CONTACT_PANEL_UNVERIFIED'});assert.equal(f.actions.some(a=>a.popupTransition?.id==='profile'),false);}
});

test('observed popup packets cannot omit stable causal geometry or substitute main for the popup',async t=>{
  for(const alter of [p=>delete p.geometryMode,p=>p.clientRect.right=0,p=>p.dpi=120,p=>p.stableObservations=1,p=>p.hwnd='100',p=>p.clientRectInRoot.right++]){const f=fixture(t,withObservedPopups),original=f.driver.client.request;f.driver.client.request=async(a,v)=>{const result=await original(a,v);if(a==='capture'&&v.surface==='observed-profile')alter(result.popup);return result;};await assert.rejects(f.driver.prepare(f.job),{code:'UI_QT_POPUP_BINDING_INVALID'});assert.equal(f.actions.some(a=>a.action==='chord'&&a.key==='Control+F'),false);}
});



test('confirmed paste and pointer completion omit only their redundant waits and the next observation is fresh',async t=>{
  const f=fixture(t,c=>{c.settleMs=250;c.layout.focusActivateRect=r(400,8,500,22);c.layout.focusActivateRgbaSha256='a'.repeat(64);});const timeline=[];
  f.driver.wait=async ms=>{timeline.push({wait:ms});};const original=f.driver.client.request;
  f.driver.client.request=async(action,values)=>{timeline.push({action,key:values?.key});return original(action,values);};
  assert.equal((await f.driver.prepare(f.job,{textEntryMode:'paste'})).ready,true);
  for(const action of ['paste','movePointer']){const at=timeline.findIndex(row=>row.action===action);assert.ok(at>=0);const after=timeline[at+1];if(action==='paste')assert.deepEqual(after,{wait:400});else assert.equal(after.action,'capture');assert.equal(timeline.slice(at+1).find(row=>row.action)?.action,'capture');}
  const searchOpen=timeline.findIndex(row=>row.action==='chord'&&row.key==='Control+F');assert.deepEqual(timeline[searchOpen+1],{wait:250});
  assert.equal(timeline.some(row=>row.action==='chord'&&row.key==='Control+A'),false);
  const click=timeline.findIndex(row=>row.action==='click');assert.deepEqual(timeline[click+1],{wait:250});
});

test('unconfirmed search paste is not repeated and cannot skip its verification guard',async t=>{
  const f=fixture(t,c=>{c.settleMs=250;});const original=f.driver.client.request;let waitsAfterPaste=[];
  f.driver.client.request=async(action,values)=>{const result=await original(action,values);if(action==='paste'){result.pasteVerified=false;f.driver.wait=async ms=>waitsAfterPaste.push(ms);}return result;};
  await assert.rejects(f.driver.prepare(f.job,{textEntryMode:'paste'}),{code:'UI_QT_PASTE_UNVERIFIED'});
  assert.deepEqual(waitsAfterPaste,[250]);assert.equal(f.actions.filter(a=>a.action==='paste').length,1);assert.equal(f.actions.some(a=>a.action==='readDraft'),false);
});

test('search replace uses one native paste intention and requires its dedicated completion proof',async t=>{
  for(const kind of ['missing-proof','failed-native']){const f=fixture(t,c=>{c.settleMs=250;});const original=f.driver.client.request;
    f.driver.client.request=async(action,values)=>{if(action==='paste'&&kind==='failed-native'){f.actions.push({action,...values});throw Object.assign(Error('uncertain'),{code:'QT_PASTE_READBACK_UNCONFIRMED',attempted:true,clipboardRestored:true});}const result=await original(action,values);if(action==='paste')delete result.searchReplaced;return result;};
    await assert.rejects(f.driver.prepare(f.job,{textEntryMode:'paste'}),{code:kind==='missing-proof'?'UI_QT_PASTE_UNVERIFIED':'QT_PASTE_READBACK_UNCONFIRMED'});
    const attempts=f.actions.filter(a=>a.action==='paste');assert.equal(attempts.length,1);assert.equal(attempts[0].replaceSearch,true);assert.equal(attempts[0].scope,'search');assert.equal(attempts[0].expectedText,attempts[0].text);
    assert.equal(f.actions.some(a=>a.action==='chord'&&a.key==='Control+A'),false);assert.equal(f.actions.some(a=>a.action==='readDraft'),false);
    const before=f.actions[f.actions.indexOf(attempts[0])-1];assert.equal(before.action,'capture');assert.deepEqual(before.regions,[f.driver.config.layout.search]);
  }
});

test('combined search paste leaves humanized selection and editor append behavior unchanged',async t=>{
  const typed=fixture(t);await typed.driver.prepare(typed.job);assert.equal(typed.actions.filter(a=>a.action==='chord'&&a.key==='Control+A').length,1);assert.equal(typed.actions.some(a=>a.action==='paste'),false);
  const f=fixture(t);await f.driver.prepare(f.job,{textEntryMode:'paste'});const state=await f.driver.observe(f.job);await f.driver.pasteText(f.job,{expectedDraft:'',editorToken:state.editorToken,activityRevision:state.activityRevision,text:'正文'},{canInput:()=>true});
  const editor=f.actions.find(a=>a.action==='paste'&&a.scope==='editor');assert.ok(editor);assert.equal(Object.hasOwn(editor,'replaceSearch'),false);assert.equal(f.actions.filter(a=>a.action==='paste'&&a.scope==='search').length,1);
});

test('each parked foreground return waits for its minimum gap and does not resume after activity in that gap',async t=>{
  const f=fixture(t);let releaseGap,entered;const reached=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>releaseGap=resolve);let first=true;
  f.driver.wait=async ms=>{if(ms===250&&first&&f.actions.at(-1).action==='parkFocusHandoff'){first=false;entered();await gate;}};
  const pending=f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}});await reached;
  assert.equal(f.actions.some(a=>a.action==='resumeFocusHandoff'),false);f.setRevision(1);releaseGap();
  assert.deepEqual(await pending,{ready:false,reason:'QT_HUMAN_ACTIVITY_CHANGED'});
  assert.equal(f.actions.some(a=>a.action==='click'),false);
});


const sameFixtureRect=(a,b)=>a&&b&&['left','top','right','bottom'].every(key=>a[key]===b[key]);
test('preparation navigates, verifies account and target aliases, then passive observation sends no input',async t=>{
  const f=fixture(t);assert.equal((await f.driver.prepare(f.job)).ready,true);
  const before=f.actions.length;const state=await f.driver.observe(f.job);assert.equal(state.ready,true);assert.equal(state.draft,'');
  assert.deepEqual(f.actions.slice(before).map(a=>a.action),['capture']);
  const read=f.actions.find(a=>a.action==='readDraft');assert.equal(read.emptyEditorSha256,'c'.repeat(64));
  assert.deepEqual(read.emptyEditorSha256s,['c'.repeat(64)]);
});

test('draft inspection parks only the pointer on a fresh title anchor without changing editor focus',async t=>{
  const f=fixture(t,c=>{c.layout.focusActivateRect=r(400,8,500,22);c.layout.focusActivateRgbaSha256='a'.repeat(64);});
  assert.equal((await f.driver.prepare(f.job)).ready,true);
  const parked=f.actions.findIndex(value=>value.action==='movePointer');assert.ok(parked>0);
  assert.deepEqual(f.actions[parked-1].regions,[f.driver.config.layout.focusActivateRect]);
  assert.deepEqual(f.actions[parked].rect,f.driver.config.layout.focusActivateRect);
  assert.equal(f.actions[parked].token,f.actions.find(value=>value.action==='readDraft').token);
  assert.deepEqual(f.actions.slice(parked,parked+3).map(value=>value.action),['movePointer','capture','readDraft']);
  assert.equal(f.actions.find(value=>value.action==='readDraft').emptyEditorSha256,'c'.repeat(64));
  const before=f.actions.length;await f.driver.readDraft();assert.deepEqual(f.actions.slice(before).map(value=>value.action),['capture','movePointer','capture','readDraft','capture']);
});

test('pointer parking refusals stop before clipboard reading and never repeat the move',async t=>{
  for(const code of ['QT_PIXELS_CHANGED','QT_HUMAN_ACTIVITY_CHANGED','QT_POINTER_PARK_INVALID']){
    const f=fixture(t,c=>{c.layout.focusActivateRect=r(400,8,500,22);c.layout.focusActivateRgbaSha256='a'.repeat(64);});
    await f.driver.prepare(f.job);const before=f.actions.length;f.setFailure('movePointer',code);await assert.rejects(f.driver.readDraft(),{code});
    assert.equal(f.actions.slice(before).filter(value=>value.action==='movePointer').length,1);assert.equal(f.actions.slice(before).some(value=>value.action==='readDraft'),false);
  }
});

test('parking requires native confirmation that keyboard focus was preserved',async t=>{
  const f=fixture(t,c=>{c.layout.focusActivateRect=r(400,8,500,22);c.layout.focusActivateRgbaSha256='a'.repeat(64);});
  const original=f.driver.client.request;f.driver.client.request=async(action,values)=>{const result=await original(action,values);return action==='movePointer'?{...result,focusPreserved:false}:result;};
  await assert.rejects(f.driver.prepare(f.job),{code:'UI_QT_POINTER_PARK_UNCONFIRMED'});assert.equal(f.actions.some(value=>value.action==='readDraft'),false);
});

test('OCR warms before either text or voice borrows focus and never changes the identity image',async t=>{
  for(const voice of [false,true]){
    const f=fixture(t);if(voice)f.driver.config.voice=voiceCalibration();let warmed=0;
    const models=new Set();f.driver.warmOcr=async options=>{assert.ok(['small','medium'].includes(options.model));models.add(options.model);if(warmed===0)assert.equal(f.actions.length,0);warmed++;};
    const original=f.driver.recognize;f.driver.recognize=async options=>{assert.ok(warmed>0);assert.equal(options.region,undefined);return original(options);};
    if(voice)await f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff'}});
    else await f.driver.prepare(f.job,{interactionPlan:{sendMode:'focus-handoff'}});
    assert.ok(warmed>0);assert.deepEqual(models,new Set(['small','medium']));assert.ok(f.actions.some(a=>a.action==='beginFocusHandoff'));
  }
});

test('OCR preload failure or cancellation never acquires focus or sends input',async t=>{
  for(const voice of [false,true]){
    const f=fixture(t);if(voice)f.driver.config.voice=voiceCalibration();
    f.driver.warmOcr=async()=>{throw Object.assign(new Error('model unavailable'),{code:'VISUAL_MODEL_UNAVAILABLE'});};
    const prepare=options=>voice?f.driver.prepareVoiceSession(f.job,options):f.driver.prepare(f.job,options);
    await assert.rejects(prepare({interactionPlan:{executionMode:'focus-handoff'}}),{code:'VISUAL_MODEL_UNAVAILABLE'});assert.equal(f.actions.length,0);
    const abort=new AbortController();f.driver.warmOcr=async({signal})=>{assert.equal(signal,abort.signal);abort.abort();};
    await assert.rejects(prepare({signal:abort.signal,interactionPlan:{executionMode:'focus-handoff'}}),{code:'UI_QT_CANCELLED'});assert.equal(f.actions.length,0);
  }
  const windows=fixture(t,c=>c.ocrBackend='windows');windows.driver.warmOcr=async()=>{throw new Error('unexpected preload');};
  assert.equal((await windows.driver.prepare(windows.job)).ready,true);
});

test('initial contact lookup finishes before borrowing focus and preserves fresh account/profile checks',async t=>{
  for(const voice of [false,true]){
    const f=fixture(t);if(voice)f.driver.config.voice=voiceCalibration();let lookups=0,accounts=0;const profiles=[];
    f.driver.resolveTarget=async(job,{signal})=>{assert.equal(job.target,f.job.target);assert.equal(signal,undefined);assert.equal(f.actions.length,0);lookups++;return{wechatId:job.target,alias:'target_A',ambiguous:false};};
    const account=f.driver.probeAccount;f.driver.probeAccount=async input=>{assert.ok(f.actions.some(a=>a.action==='beginFocusHandoff'));accounts++;return account(input);};
    f.driver.verifyContact=async input=>{profiles.push(input.query.expectedUsername);return{matched:true,unique:true,comparison:'exact'};};
    if(voice)await f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff'}});
    else{await f.driver.prepare(f.job,{interactionPlan:{sendMode:'focus-handoff'}});await f.driver.prepare(f.job,{interactionPlan:{sendMode:'focus-handoff'}});}
    assert.equal(lookups,1);assert.ok(accounts>=1);assert.deepEqual(profiles,[f.job.account,f.job.target]);
  }
});

test('invalid, cancelled or changed background lookup cannot activate or navigate',async t=>{
  for(const mode of ['invalid','cancel','changed']){
    const f=fixture(t),abort=new AbortController();f.driver.resolveTarget=async(job,{signal})=>{assert.equal(signal,abort.signal);if(mode==='cancel')abort.abort();if(mode==='changed')job.target='wxid_changed';return{wechatId:mode==='invalid'?'wxid_other':'wxid_target',alias:'target_A',ambiguous:false};};
    await assert.rejects(f.driver.prepare(f.job,{signal:abort.signal,interactionPlan:{sendMode:'focus-handoff'}}),{code:mode==='cancel'?'UI_QT_CANCELLED':mode==='changed'?'UI_QT_TARGET_CHANGED':'UI_QT_TARGET_ALIAS_REQUIRED'});
    assert.equal(f.actions.length,0);
  }
});

test('background contact metadata cannot replace the final opened-profile database verification',async t=>{
  const f=fixture(t);f.driver.verifyContact=async input=>({matched:input.query.expectedUsername===f.job.account,unique:true,comparison:'exact'});
  await assert.rejects(f.driver.prepare(f.job,{interactionPlan:{sendMode:'focus-handoff'},textEntryMode:'paste'}),{code:'UI_QT_CONTACT_UNVERIFIED'});
  assert.equal(f.actions.some(a=>a.action==='readDraft'),false);assert.equal(f.actions.some(a=>a.action==='click'&&JSON.stringify(a.rect)===JSON.stringify(f.driver.config.layout.send)),false);
});

test('calibrated focus click is optional, tightly bounded and carried into the native voice handoff',async t=>{
  const apply=c=>{c.layout.focusActivateRect=r(350,8,450,22);c.layout.focusActivateRgbaSha256='d'.repeat(64);};
  const f=fixture(t,apply);f.driver.config.voice=voiceCalibration();
  const fresh=await f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff'}});
  const activation={rect:f.driver.config.layout.focusActivateRect,rgbaSha256:'d'.repeat(64)};
  assert.deepEqual(f.actions.find(a=>a.action==='beginFocusHandoff').focusActivation,activation);assert.deepEqual(fresh.focusHandoff.activation,activation);
  for(const mutate of [c=>delete c.layout.focusActivateRgbaSha256,c=>delete c.layout.focusActivateRect,c=>c.layout.focusActivateRgbaSha256='bad',c=>c.layout.focusActivateRect.left=0,c=>c.layout.focusActivateRect.right=799,c=>c.layout.focusActivateRect.bottom=50]){
    const c=config();apply(c);mutate(c);assert.throws(()=>validateQtConfig(c),{code:'UI_QT_FOCUS_CALIBRATION_INVALID'});
  }
});

test('legacy calibration and a group result stop before result selection even if its member profile could match',async t=>{
  const missing=fixture(t,c=>delete c.layout.searchResultIdentity);
  await assert.rejects(missing.driver.prepare(missing.job),{code:'UI_QT_SEARCH_IDENTITY_CALIBRATION_REQUIRED'});
  assert.equal(missing.actions.some(a=>a.action==='click'||a.action==='type'),false);
  const grouped=fixture(t),original=grouped.driver.recognize;
  grouped.driver.recognize=async input=>{const value=await original(input);if(value.words[0]?.text==='联系人')value.words[0].text='群聊';return value;};
  await assert.rejects(grouped.driver.prepare(grouped.job),{code:'UI_QT_PRIVATE_CHAT_UNVERIFIED'});
  assert.equal(grouped.actions.some(a=>a.action==='click'&&JSON.stringify(a.rect)===JSON.stringify(grouped.driver.config.layout.firstResult)),false);
});

test('a changed search row after OCR cannot use a newly captured token to click another result',async t=>{
  const f=fixture(t),original=f.driver.recognize;
  f.driver.recognize=async input=>{const result=await original(input);if(result.words[0]?.text==='联系人')f.setHeader('a'.repeat(64));return result;};
  await assert.rejects(f.driver.prepare(f.job),{code:'UI_QT_SEARCH_RESULT_CHANGED'});
  assert.equal(f.actions.some(a=>a.action==='click'&&JSON.stringify(a.rect)===JSON.stringify(f.driver.config.layout.firstResult)),false);
});

test('uncertain search ID confidence retries one medium model on the same complete calibrated row',async t=>{
  const f=fixture(t),original=f.driver.recognize;const calls=[];
  f.driver.recognize=async options=>{const result=await original(options);if(result.words[0]?.text!=='联系人')return result;calls.push(options);
    result.width=800;result.height=600;
    if(options.model==='medium'){result.model='PP-OCRv6-medium';result.region=options.region;}else result.words[2].confidence=.7;
    return result;};
  assert.equal((await f.driver.prepare(f.job)).ready,true);
  assert.deepEqual(calls.map(c=>c.model),['small','medium']);assert.equal(calls[0].file,calls[1].file);assert.equal(calls[0].region,undefined);assert.deepEqual(calls[1].region,f.driver.config.layout.searchResultIdentity);
  for(const call of calls){assert.equal(call.preprocess,undefined);assert.equal(call.expected,undefined);assert.equal(call.expectedId,undefined);}
  assert.equal(f.actions.filter(a=>a.action==='click'&&JSON.stringify(a.rect)===JSON.stringify(f.driver.config.layout.firstResult)).length,1);
});

test('medium search retry cannot repair another identity, group match, changed source or low-confidence retry',async t=>{
  for(const failure of ['first-id','first-group','hash','preprocess','region','model','size','retry-id','retry-confidence','pixels']){
    const f=fixture(t),original=f.driver.recognize;let retries=0;
    f.driver.recognize=async options=>{const result=await original(options);if(result.words[0]?.text!=='联系人')return result;result.width=800;result.height=600;
      if(options.model!=='medium'){result.words[2].confidence=.7;if(failure==='first-id')result.words[2].text='微信号：other';if(failure==='first-group')result.words[0].text='群聊';}
      else{retries++;result.model='PP-OCRv6-medium';result.region={...options.region};if(failure==='hash')result.imageSha256='f'.repeat(64);if(failure==='preprocess')result.preprocess='gray-gamma-1.6';if(failure==='region')result.region.left++;if(failure==='model')result.model='PP-OCRv6-small';if(failure==='size')result.width++;if(failure==='retry-id')result.words[2].text='微信号：other';if(failure==='retry-confidence')result.words[2].confidence=.8;if(failure==='pixels')f.setHeader('a'.repeat(64));}return result;};
    await assert.rejects(f.driver.prepare(f.job),{code:failure==='pixels'?'UI_QT_SEARCH_RESULT_CHANGED':'UI_QT_PRIVATE_CHAT_UNVERIFIED'});
    assert.equal(retries,failure.startsWith('first-')?0:1);assert.equal(f.actions.some(a=>a.action==='click'&&JSON.stringify(a.rect)===JSON.stringify(f.driver.config.layout.firstResult)),false);
  }
});

test('adaptive search binds the full popup image and native pixels before region OCR while preserving whole-popup recheck',async t=>{
  const f=fixture(t,withObservedPopups),original=f.driver.recognize,calls=[];f.driver.locateContactPanel=async options=>panelProof(options);
  f.driver.recognize=async options=>{const result=await original(options);if(result.words[0]?.text!=='联系人')return result;
    calls.push(options);if(options.model==='small')result.words[2].confidence=.7;return result;};
  assert.equal((await f.driver.prepare(f.job)).ready,true);
  assert.deepEqual(calls.map(c=>c.model),['small','medium']);assert.deepEqual(calls[0].region,r(60,65,460,230));assert.deepEqual(calls[1].region,calls[0].region);
  assert.equal(calls[0].file,calls[1].file);assert.ok(f.actions.some(a=>a.action==='capture'&&a.surface==='observed-search'&&a.regions.length===0));
});

test('unbound search content geometry and mismatched region OCR stop before selecting a result',async t=>{
  for(const failure of ['image','pixels','bounds','popup','dpi','readonly','authorized','extra','region','model','transform']){
    const f=fixture(t,withObservedPopups),locate=f.driver.locateSearchPopup,recognize=f.driver.recognize;let searches=0,afterProof;
    f.driver.locateSearchPopup=async input=>{const p=await locate(input);afterProof=f.actions.length;
      if(failure==='image')p.imageSha256='0'.repeat(64);if(failure==='pixels')p.popupRgbaSha256='0'.repeat(64);if(failure==='bounds')p.contentRect={...p.contentRect,left:0};
      if(failure==='popup')p.popupRect={...p.popupRect,bottom:p.popupRect.bottom-1};if(failure==='dpi')p.dpi++;if(failure==='readonly')p.readOnly=false;if(failure==='authorized')p.identityVerified=true;if(failure==='extra')p.extra=true;return p;};
    f.driver.recognize=async input=>{const p=await recognize(input);if(p.words[0]?.text==='联系人'){searches++;if(failure==='region')p.region={...p.region,left:61};if(failure==='model')p.model='PP-OCRv6-medium';if(failure==='transform')p.preprocess='gray-gamma-1.6';}return p;};
    await assert.rejects(f.driver.prepare(f.job),{code:['region','model','transform'].includes(failure)?'UI_QT_PRIVATE_CHAT_UNVERIFIED':'UI_QT_SEARCH_POPUP_CONTENT_UNVERIFIED'});
    assert.equal(searches,['region','model','transform'].includes(failure)?1:0);assert.equal(f.actions.slice(afterProof).some(a=>a.action==='click'),false);
  }
});

test('adaptive Windows OCR retains its supported whole-image request and exact observed private proof',async t=>{
  const f=fixture(t,c=>{withObservedPopups(c);c.ocrBackend='windows';}),recognize=f.driver.recognize;f.driver.locateContactPanel=async options=>panelProof(options);let searches=0;
  f.driver.recognize=async options=>{assert.equal(options.region,undefined);const result=await recognize(options);delete result.model;if(result.words[0]?.text==='联系人')searches++;return result;};
  assert.equal((await f.driver.prepare(f.job)).ready,true);assert.equal(searches,1);
});

test('shared text owns one focus lease across preparation and releases once immediately after submit',async t=>{
  const f=fixture(t),interactionPlan={executionMode:'focus-handoff'};
  assert.equal((await f.driver.prepare(f.job,{interactionPlan,textEntryMode:'paste'})).ready,true);
  assert.equal(f.actions.filter(a=>a.action==='beginFocusHandoff').length,1);
  const state=await f.driver.observe(f.job);
  await f.driver.submit(f.job,{expectedDraft:'',editorToken:state.editorToken,activityRevision:state.activityRevision,canSubmit:()=>true});
  assert.equal(f.actions.filter(a=>a.action==='releaseFocusHandoff').length,1);
  await f.driver.releaseTextFocus();assert.equal(f.actions.filter(a=>a.action==='releaseFocusHandoff').length,1);
  assert.equal(f.driver.current,null);
});

test('shared text returns foreground after a preparation refusal and never reports unknown cleanup as success',async t=>{
  const f=fixture(t);f.setFailure('capture','QT_USER_ACTIVE');
  const result=await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}});
  assert.equal(result.ready,false);assert.equal(f.actions.filter(a=>a.action==='releaseFocusHandoff').length,1);
  const unknown=fixture(t);await unknown.driver.prepare(unknown.job,{interactionPlan:{executionMode:'focus-handoff'}});
  unknown.setFailure('releaseFocusHandoff','QT_FOCUS_RETURN_UNCONFIRMED');
  await assert.rejects(unknown.driver.releaseTextFocus(),{code:'UI_QT_FOCUS_RETURN_UNCONFIRMED'});
});

test('shared text already in WeChat stays foreground without borrowing or returning focus',async t=>{
  const f=fixture(t),original=f.driver.client.request.bind(f.driver.client);
  f.driver.client.request=async(action,values)=>action==='inspectFocusHandoff'?{ready:false,reason:'QT_FOCUS_RETURN_WINDOW_REQUIRED',inputSent:false,clipboardAccessed:false,focusChanged:false}:original(action,values);
  assert.equal((await f.driver.prepare(f.job,{interactionPlan:{sendMode:'focus-handoff'}})).ready,true);
  assert.equal(f.actions.some(a=>a.action==='beginFocusHandoff'),false);await f.driver.releaseTextFocus();
  assert.equal(f.actions.some(a=>a.action==='releaseFocusHandoff'),false);
});

test('adaptive shared mode keeps direct search and unchecked draft when WeChat already owns focus',async t=>{
  const f=fixture(t,withObservedPopups),request=f.driver.client.request;
  let preflights=0;f.driver.client.request=async(action,input)=>{
    if(action==='inspectFocusHandoff'){preflights++;return{ready:false,reason:'QT_FOCUS_RETURN_WINDOW_REQUIRED',inputSent:false,clipboardAccessed:false,focusChanged:false};}
    // Model the native contract: unchecked paste without a borrowed lease
    // requires its explicit already-foreground mode.
    if(action==='paste'&&input.readback===false)assert.equal(input.foregroundOnly,true);
    return request(action,input);
  };
  const options={interactionPlan:{sendMode:'focus-handoff'},textEntryMode:'paste'};
  assert.equal((await f.driver.prepare(f.job,options)).ready,true);
  assert.equal(f.driver.current.shared,true);assert.equal(f.driver.current.draftPolicy,'unchecked');
  assert.equal(f.actions.filter(a=>a.action==='searchEnter').length,1);
  assert.equal(f.actions.some(a=>['beginFocusHandoff','releaseFocusHandoff','readDraft'].includes(a.action)||a.popupTransition?.id==='self'||a.popupTransition?.id==='profile'),false);
  let observed=await f.driver.observe(f.job);
  const pasted=await f.driver.pasteText(f.job,{expectedDraft:'',editorToken:observed.editorToken,activityRevision:observed.activityRevision,text:'好'},{canInput:()=>true});assert.equal(pasted.performed,true);
  const preparedActions=f.actions.length;
  assert.equal((await f.driver.prepare({...f.job,state:'typing'},options)).ready,true);
  assert.equal(f.actions.length,preparedActions);assert.equal(preflights,1);
  observed=await f.driver.observe(f.job);assert.equal((await f.driver.submit(f.job,{expectedDraft:'好',editorToken:observed.editorToken,activityRevision:observed.activityRevision,canSubmit:()=>true})).performed,true);
  assert.equal(f.actions.filter(a=>a.action==='paste'&&a.scope==='search').length,1);assert.equal(f.actions.filter(a=>a.action==='paste'&&a.scope==='editor').length,1);assert.equal(f.actions.filter(a=>a.action==='submitTextEnter').length,1);
  assert.equal(f.actions.some(a=>['beginFocusHandoff','releaseFocusHandoff','resumeTextEnterProof','readDraft'].includes(a.action)),false);
  await f.driver.releaseTextFocus();assert.equal(f.actions.some(a=>a.action==='releaseFocusHandoff'),false);
});

test('shared background paste retains its borrowed lease and does not request foreground-only admission',async t=>{
  const f=fixture(t,withObservedPopups);await f.driver.prepare(f.job,{interactionPlan:{sendMode:'focus-handoff'},textEntryMode:'paste'});
  const observed=await f.driver.observe(f.job);await f.driver.pasteText(f.job,{expectedDraft:'',editorToken:observed.editorToken,activityRevision:observed.activityRevision,text:'好'},{canInput:()=>true});
  assert.equal(f.actions.filter(a=>a.action==='beginFocusHandoff').length,1);
  assert.equal(f.actions.filter(a=>a.action==='paste').length,2);assert.equal(f.actions.filter(a=>a.action==='paste').every(a=>a.readback===false&&a.foregroundOnly===undefined),true);
});

test('already-foreground mode still stops native input when focus changes after preparation',async t=>{
  const f=fixture(t,withObservedPopups),request=f.driver.client.request;
  f.driver.client.request=async(action,input)=>action==='inspectFocusHandoff'?{ready:false,reason:'QT_FOCUS_RETURN_WINDOW_REQUIRED',inputSent:false,clipboardAccessed:false,focusChanged:false}:request(action,input);
  await f.driver.prepare(f.job,{interactionPlan:{sendMode:'focus-handoff'},textEntryMode:'paste'});
  f.setFailure('paste','DRAFT_WINDOW_NOT_FOREGROUND',{attempted:false});const observed=await f.driver.observe(f.job);
  const result=await f.driver.pasteText(f.job,{expectedDraft:'',editorToken:observed.editorToken,activityRevision:observed.activityRevision,text:'好'},{canInput:()=>true});
  assert.equal(result.performed,false);assert.equal(result.attempted,false);assert.equal(f.actions.some(a=>a.action==='submitTextEnter'||a.action==='beginFocusHandoff'),false);
});

test('shared text reuses one lease across ticks and rechecks a parked partial draft before resuming',async t=>{
  const f=fixture(t),options={interactionPlan:{sendMode:'focus-handoff'}};
  await f.driver.prepare(f.job,options);await f.driver.prepare(f.job,options);
  assert.equal(f.actions.filter(a=>a.action==='beginFocusHandoff').length,1);
  const state=await f.driver.observe(f.job);
  await f.driver.typeGrapheme(f.job,{expectedDraft:'',editorToken:state.editorToken,activityRevision:state.activityRevision,text:'好'},{canInput:()=>true});
  await f.driver.releaseTextFocus();assert.equal((await f.driver.observe(f.job)).ready,false);
  assert.equal((await f.driver.prepare({...f.job,index:1},options)).ready,true);
  assert.equal(f.driver.current.draft,'好');assert.equal(f.actions.filter(a=>a.action==='beginFocusHandoff').length,2);
  await f.driver.releaseTextFocus();f.setRevision(1);
  assert.deepEqual(await f.driver.prepare({...f.job,index:1},options),{ready:false,reason:'UI_QT_PARTIAL_DRAFT_RECHECK_REQUIRED'});
  assert.equal(f.driver.current,null);assert.ok(f.driver.draftHold);
});
test('calibrated popup flow arms only exact opening actions and still verifies both complete identities',async t=>{
  const f=fixture(t,withPopups);let verified=[];f.driver.verifyContact=async value=>{verified.push(value.query.displayedId);return{matched:true,unique:true,comparison:'exact'};};
  assert.equal((await f.driver.prepare(f.job,{textEntryMode:'paste'})).ready,true);
  const transitions=f.actions.filter(a=>a.popupTransition);assert.deepEqual(transitions.map(a=>[a.action,a.popupTransition.id]),[['click','self'],['chord','search'],['click','profile']]);
  assert.equal(transitions[1].key,'Control+F');
  assert.deepEqual(verified,['my_alias','target_A']);
  assert.ok(f.actions.some(a=>a.action==='capture'&&a.surface==='calibrated-profile'&&a.surfaceId==='self'));
  assert.ok(f.actions.some(a=>a.action==='capture'&&a.surface==='calibrated-search'&&a.surfaceId==='search'));
  const firstResult=f.actions.findIndex(a=>a.action==='click'&&JSON.stringify(a.rect)===JSON.stringify(f.driver.config.layout.firstResult));
  assert.equal(f.actions.slice(firstResult+1).find(a=>a.action==='capture').surface,'main');
});
test('contact profile transition is attached to the final member click when a panel is required',async t=>{
  const f=fixture(t,c=>{withPopups(c);c.layout.profileMember=r(500,80,560,130);c.layout.profilePanelClose=r(680,20,710,60);});
  assert.equal((await f.driver.prepare(f.job)).ready,true);
  const opened=f.actions.find(a=>a.popupTransition?.id==='profile');assert.deepEqual(opened.rect,f.driver.config.layout.profileMember);
  assert.equal(f.actions.find(a=>a.action==='click'&&JSON.stringify(a.rect)===JSON.stringify(f.driver.config.layout.profileOpen)).popupTransition,undefined);
});

test('shared profile recognition closes the member panel and recreates its full route after parking',async t=>{
  const f=fixture(t,c=>{withPopups(c);c.layout.profileMember=r(500,80,560,130);c.layout.profilePanelClose=r(680,20,710,60);});
  assert.equal((await f.driver.prepare(f.job,{interactionPlan:{sendMode:'focus-handoff'},textEntryMode:'paste'})).ready,true);
  const clicks=name=>f.actions.filter(action=>action.action==='click'&&JSON.stringify(action.rect)===JSON.stringify(f.driver.config.layout[name]));
  assert.equal(clicks('profileOpen').length,2);assert.equal(clicks('profileMember').length,2);assert.equal(clicks('profilePanelClose').length,2);
  assert.ok(clicks('profileMember').every(action=>action.popupTransition?.id==='profile'));
  assert.equal(f.actions.filter(action=>action.action==='readDraft').length,1);
});
test('missing, wrong-surface and unstable popup evidence stops before contact search or text input',async t=>{
  for(const alter of [frame=>delete frame.popup,frame=>frame.popup.surfaceId='profile',frame=>frame.popup.hwnd='999',frame=>frame.popup.ownerRelation='root-owned',frame=>frame.popup.stableObservations=1]){
    const f=fixture(t,withPopups),original=f.driver.client.request.bind(f.driver.client);
    f.driver.client.request=async(action,values)=>{const result=await original(action,values);if(action==='capture'&&values.surface==='calibrated-profile')alter(result);return result;};
    await assert.rejects(f.driver.prepare(f.job),{code:'UI_QT_POPUP_BINDING_INVALID'});
    assert.equal(f.actions.some(a=>a.action==='type'||a.action==='paste'||a.key==='Control+F'),false);
  }
});
test('calibrated popup geometry does not substitute for complete account or contact identity',async t=>{
  const f=fixture(t,withPopups);f.driver.recognize=async()=>({imageSha256:digest('fixture'),words:[word('微信号：wrong_alias',f.driver.config.selfSurface.alias)]});
  await assert.rejects(f.driver.prepare(f.job),{code:'UI_QT_PROFILE_ID_UNVERIFIED'});
  assert.equal(f.actions.some(a=>a.key==='Control+F'),false);
});
test('search popup evidence cannot identify the main window as its separate overlay',async t=>{
  const f=fixture(t,withPopups),original=f.driver.client.request.bind(f.driver.client);
  f.driver.client.request=async(action,values)=>{const result=await original(action,values);if(action==='capture'&&values.surface==='calibrated-search')result.popup.hwnd=result.binding.hwnd;return result;};
  await assert.rejects(f.driver.prepare(f.job),{code:'UI_QT_POPUP_BINDING_INVALID'});
  assert.equal(f.actions.some(a=>a.action==='type'||a.action==='paste'),false);
});
test('text and native voice preparation forward the same complete empty-template list',async t=>{
  const f=fixture(t),variants=['c'.repeat(64),'d'.repeat(64)];f.driver.config.layout.emptyEditorSha256s=variants;
  await f.driver.prepare(f.job);
  assert.deepEqual(f.actions.filter(a=>a.action==='readDraft').at(-1).emptyEditorSha256s,variants);
  f.driver.config.voice=voiceCalibration();
  await f.driver.prepareVoiceSession(f.job);
  assert.deepEqual(f.actions.filter(a=>a.action==='readDraft').at(-1).emptyEditorSha256s,variants);
});
test('typing is one character, read-back verifies it, and submit receives a separate fresh guard',async t=>{
  const f=fixture(t);await f.driver.prepare(f.job);const state=await f.driver.observe(f.job);
  const result=await f.driver.typeGrapheme(f.job,{expectedDraft:'',editorToken:state.editorToken,activityRevision:state.activityRevision,text:'好'},{canInput:()=>true});assert.equal(result.attempted,true);
  const next=await f.driver.observe(f.job);assert.equal(next.draft,'好');
  const before=f.actions.length;assert.equal((await f.driver.submit(f.job,{expectedDraft:'好',editorToken:next.editorToken,activityRevision:next.activityRevision,canSubmit:()=>false})).attempted,false);
  assert.equal(f.actions.slice(before).some(a=>a.action==='click'),false);
});
test('human input invalidates observation and prevents typing',async t=>{
  const f=fixture(t);await f.driver.prepare(f.job);const state=await f.driver.observe(f.job);f.setRevision(1);
  assert.equal((await f.driver.observe(f.job)).ready,false);
  const before=f.actions.length;const result=await f.driver.typeGrapheme(f.job,{expectedDraft:'',editorToken:state.editorToken,activityRevision:state.activityRevision,text:'好'},{canInput:()=>true});
  assert.equal(result.attempted,false);assert.equal(f.actions.slice(before).some(a=>a.action==='type'),false);
});
test('existing draft is preserved and blocks switching contacts',async t=>{
  const f=fixture(t);f.setDraft('user draft');await f.driver.prepare(f.job);
  const before=f.actions.length;
  for(let i=0;i<2;i++)assert.deepEqual(await f.driver.prepare({...f.job,target:'wxid_other'}),{ready:false,reason:'UI_QT_DRAFT_CONFLICT'});
  assert.equal(f.actions.length,before);assert.equal(f.driver.current,null);
});
test('partial draft cannot be re-associated with a chat after human activity',async t=>{
  const f=fixture(t);await f.driver.prepare(f.job);f.setRevision(1);
  assert.deepEqual(await f.driver.prepare({...f.job,index:1}),{ready:false,reason:'UI_QT_PARTIAL_DRAFT_RECHECK_REQUIRED'});
  const before=f.actions.length;
  assert.deepEqual(await f.driver.prepare({...f.job,index:1}),{ready:false,reason:'UI_QT_PARTIAL_DRAFT_RECHECK_REQUIRED'});
  assert.equal(f.actions.length,before);
});
test('definite native refusal does not claim input, no automatic resend',async t=>{
  const f=fixture(t);await f.driver.prepare(f.job);const state=await f.driver.observe(f.job);f.setFailure('type');
  const before=f.actions.length;const result=await f.driver.typeGrapheme(f.job,{expectedDraft:'',editorToken:state.editorToken,activityRevision:state.activityRevision,text:'好'},{canInput:()=>true});assert.equal(result.attempted,false);assert.equal(f.actions.slice(before).filter(a=>a.action==='type').length,1);
});
test('a failed read-back after accepted typing must stay uncertain even if read-back refused before its own input',async t=>{
  const f=fixture(t);await f.driver.prepare(f.job);const state=await f.driver.observe(f.job);f.setFailure('readDraft');
  await assert.rejects(f.driver.typeGrapheme(f.job,{expectedDraft:'',editorToken:state.editorToken,activityRevision:state.activityRevision,text:'好'},{canInput:()=>true}),{code:'QT_PIXELS_CHANGED'});
  assert.equal((await f.driver.observe(f.job)).ready,false);
  assert.equal(f.actions.filter(a=>a.action==='type'&&a.text==='好').length,1);
});
test('unverified newline shortcut refuses before any native input',async t=>{
  const f=fixture(t);await f.driver.prepare(f.job);const state=await f.driver.observe(f.job);const before=f.actions.length;
  const result=await f.driver.typeGrapheme(f.job,{expectedDraft:'',editorToken:state.editorToken,activityRevision:state.activityRevision,text:'\n'},{canInput:()=>true});
  assert.equal(result.attempted,false);assert.equal(result.reason,'UI_QT_NEWLINE_CALIBRATION_REQUIRED');assert.equal(f.actions.length,before);
});
test('voice handoff verifies an empty draft and releases the native input owner before returning session',async t=>{
  const f=fixture(t);f.driver.config.voice={recordStartRect:r(310,410,340,440),mouseParkRect:r(600,100,610,110),recordingUi:{focusHwnd:'same',cancel:{rect:r(350,410,380,440),rgbaSha256:'a'.repeat(64)},submit:{rect:r(700,410,730,440),rgbaSha256:'b'.repeat(64)}}};
  const {session,accountProof}=await f.driver.prepareVoiceSession(f.job);
  assert.equal(session.version,2);assert.equal(session.target,f.job.target);assert.equal(session.targetProof.kind,'verified-qt-private-chat-v1');assert.equal(session.emptyDraftConfirmed,true);
  assert.equal(session.recordingUi.focusHwnd,'100');assert.equal(accountProof.accountRef,'a'.repeat(64));assert.equal(f.actions.at(-1).action,'release');assert.equal(f.driver.current,null);
});
test('cancelling preparation stops the helper and prevents further navigation commands',async t=>{
  const f=fixture(t),controller=new AbortController();let closed=false;
  f.driver.client.close=async()=>{closed=true;return{processStopped:true};};f.driver.wait=async()=>{if(f.actions.some(action=>action.action==='click'))controller.abort();};
  await assert.rejects(f.driver.prepare(f.job,{signal:controller.signal}),{code:'UI_QT_CANCELLED'});assert.equal(closed,true);
  assert.equal(f.actions.filter(a=>['click','chord','type'].includes(a.action)).length,1);
});

test('voice preparation preserves a wait refusal without creating a recording session or mislabeling the draft',async t=>{
  const f=fixture(t);f.driver.config.voice={recordStartRect:r(310,410,340,440),mouseParkRect:r(600,100,610,110),recordingUi:{focusHwnd:'same',cancel:{rect:r(350,410,380,440),rgbaSha256:'a'.repeat(64)},submit:{rect:r(700,410,730,440),rgbaSha256:'b'.repeat(64)}}};
  f.setFailure('capture','DRAFT_WINDOW_NOT_FOREGROUND');
  await assert.rejects(f.driver.prepareVoiceSession(f.job),{code:'DRAFT_WINDOW_NOT_FOREGROUND',attempted:false,waitable:true});
  assert.deepEqual(f.actions.map(action=>action.action),['capture']);assert.equal(f.driver.current,null);
});

const voiceCalibration=()=>({recordStartRect:r(310,410,340,440),mouseParkRect:r(600,100,610,110),recordingUi:{focusHwnd:'same',cancel:{rect:r(350,410,380,440),rgbaSha256:'a'.repeat(64)},submit:{rect:r(700,410,730,440),rgbaSha256:'b'.repeat(64)}}});
const adaptiveVoiceCalibration=()=>({recordStartRect:r(310,555,340,585),mouseParkRect:r(600,100,610,110),recordingUi:{focusHwnd:'same',adaptive:{version:1,executableVersion:'4.1.15.56',toolbarRect:r(300,550,780,595)}}});
test('adaptive voice layout preserves the native shape-search boundary after full Qt identity and draft checks',async t=>{
  const f=fixture(t);f.driver.config.voice=adaptiveVoiceCalibration();assert.deepEqual(await f.driver.prepareVoiceHandoff(f.job),{ready:true});
  const result=await f.driver.prepareVoiceSession(f.job);
  assert.deepEqual(result.session.recordingUi,{...adaptiveVoiceCalibration().recordingUi,focusHwnd:'100'});
  assert.equal(f.actions.filter(a=>a.action==='readDraft').length,1);assert.equal(result.session.emptyDraftConfirmed,true);
});
test('adaptive voice refuses mixed templates, unknown build, oversized toolbar or unsafe pointer parking before input',async t=>{
  for(const alter of [v=>v.recordingUi.cancel=voiceCalibration().recordingUi.cancel,v=>v.recordingUi.adaptive.executableVersion='4.1.15.57',v=>v.recordingUi.adaptive.toolbarRect.top=400,v=>v.recordingUi.adaptive.toolbarRect.right=900,v=>v.mouseParkRect=r(600,500,610,510),v=>v.recordStartRect.top=540]){const f=fixture(t);f.driver.config.voice=adaptiveVoiceCalibration();alter(f.driver.config.voice);assert.deepEqual(await f.driver.prepareVoiceHandoff(f.job),{ready:false,reason:'UI_QT_VOICE_CALIBRATION_REQUIRED'});await assert.rejects(f.driver.prepareVoiceSession(f.job),{code:'UI_QT_VOICE_CALIBRATION_REQUIRED'});assert.equal(f.actions.length,0);}
});
test('shared voice admission waits for human idle without activating, preparing or touching clipboard',async t=>{
  const f=fixture(t);f.driver.config.voice=voiceCalibration();let idle=false;
  f.driver.client.request=async(action,values)=>{f.actions.push({action,...values});assert.equal(action,'inspectFocusHandoff');return{ready:idle,reason:idle?null:'QT_USER_ACTIVE',inputSent:false,clipboardAccessed:false,focusChanged:false};};
  assert.deepEqual(await f.driver.prepareVoiceHandoff(f.job),{ready:false,reason:'QT_USER_ACTIVE'});
  assert.deepEqual(await f.driver.prepareVoiceHandoff(f.job),{ready:false,reason:'QT_USER_ACTIVE'});
  idle=true;assert.deepEqual(await f.driver.prepareVoiceHandoff(f.job),{ready:true});
  assert.deepEqual(f.actions.map(a=>a.action),['inspectFocusHandoff','inspectFocusHandoff','inspectFocusHandoff']);assert.equal(f.driver.current,null);
});
test('shared voice admission refuses missing calibration before any native operation',async t=>{
  const f=fixture(t);assert.deepEqual(await f.driver.prepareVoiceHandoff(f.job),{ready:false,reason:'UI_QT_VOICE_CALIBRATION_REQUIRED'});assert.equal(f.actions.length,0);
});
test('shared voice admission distinguishes monitor warmup from observed user activity without input',async t=>{
  const f=fixture(t);f.driver.config.voice=voiceCalibration();let reason='QT_ACTIVITY_WARMUP';
  f.driver.client.request=async(action,values)=>{f.actions.push({action,...values});return{ready:reason===null,reason,inputSent:false,clipboardAccessed:false,focusChanged:false};};
  assert.deepEqual(await f.driver.prepareVoiceHandoff(f.job),{ready:false,reason:'QT_ACTIVITY_WARMUP'});
  reason='QT_USER_ACTIVE';assert.deepEqual(await f.driver.prepareVoiceHandoff(f.job),{ready:false,reason:'QT_USER_ACTIVE'});
  reason=null;assert.deepEqual(await f.driver.prepareVoiceHandoff(f.job),{ready:true});
  assert.deepEqual(f.actions.map(row=>row.action),['inspectFocusHandoff','inspectFocusHandoff','inspectFocusHandoff']);assert.equal(f.driver.current,null);
});
test('shared admission does not trust a helper that changed focus or an aborted observation',async t=>{
  const f=fixture(t);f.driver.config.voice=voiceCalibration();
  f.driver.client.request=async()=>({ready:true,reason:null,inputSent:false,clipboardAccessed:false,focusChanged:true});
  await assert.rejects(f.driver.prepareVoiceHandoff(f.job),{code:'UI_QT_FOCUS_PREFLIGHT_INVALID'});
  const abort=new AbortController();f.driver.client.request=async()=>{abort.abort();return{ready:true,reason:null,inputSent:false,clipboardAccessed:false,focusChanged:false};};
  assert.deepEqual(await f.driver.prepareVoiceHandoff(f.job,{signal:abort.signal}),{ready:false,reason:'UI_QT_CANCELLED'});
});
test('shared voice acquires prior window before navigation, transfers once, and exposes idempotent failure cleanup',async t=>{
  const f=fixture(t);f.driver.config.voice=voiceCalibration();
  const fresh=await f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff',textEntryMode:'paste'}});
  assert.equal(f.actions[0].action,'beginFocusHandoff');
  assert.deepEqual(f.actions.slice(-2).map(a=>a.action),['transferFocusHandoff','release']);
  assert.equal(f.actions.filter(a=>a.action==='paste'&&a.scope==='search').length,2);
  assert.equal(fresh.focusHandoff.returnWindow.hwnd,'200');
  const released=await fresh.releaseFocus();assert.equal(released.restored,true);assert.equal(released.skipped,false);await fresh.releaseFocus();
  assert.equal(f.actions.filter(a=>a.action==='restoreTransferredFocus').length,1);
});
test('adaptive shared voice keeps the draft unchecked and transfers its ready main frame without editor input or duplicate capture',async t=>{
  const f=fixture(t,withObservedPopups),waits=[];f.driver.config.voice=adaptiveVoiceCalibration();f.setDraft('existing content');f.driver.wait=async ms=>waits.push(ms);
  const transition=f.driver.waitForSearchEnterTransition.bind(f.driver);let readyIndex;
  f.driver.waitForSearchEnterTransition=async baseline=>{const frame=await transition(baseline);readyIndex=f.actions.length;return frame;};
  f.driver.warmOcr=f.driver.recognize=f.driver.verifyContact=async()=>{throw Error('shared voice must not reverify contact');};
  const result=await f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff',textEntryMode:'paste'}});
  assert.equal(result.session.emptyDraftConfirmed,false);assert.equal(result.session.draftPolicy,'unchecked');assert.ok(waits.length>=1&&waits.every(ms=>ms===35));
  assert.equal(f.actions.some(a=>['readDraft','inspectEmptyEditorPhase','parkFocusHandoff','resumeFocusHandoff'].includes(a.action)),false);
  assert.equal(f.actions.some(a=>a.action==='click'),false);
  assert.deepEqual(f.actions.slice(readyIndex).map(a=>a.action),['transferFocusHandoff','release']);
  assert.equal(f.actions.filter(a=>a.action==='paste').length,1);assert.equal(f.actions.find(a=>a.action==='paste').scope,'search');
});

test('adaptive shared voice overlaps one account probe with page presentation and waits for it before transfer',async t=>{
  const f=fixture(t,withObservedPopups);f.driver.config.voice=adaptiveVoiceCalibration();const probe=f.driver.probeAccount,request=f.driver.client.request;
  const transition=f.driver.waitForSearchEnterTransition.bind(f.driver);let readyIndex;
  f.driver.waitForSearchEnterTransition=async baseline=>{const frame=await transition(baseline);readyIndex=f.actions.length;return frame;};
  let started,finish,count=0;const entered=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>finish=resolve);
  f.driver.probeAccount=async args=>{count++;assert.ok(f.actions.some(a=>a.action==='searchEnter'));started();await gate;return probe(args);};
  f.driver.client.request=async(action,values)=>{const value=await request(action,values);if(action==='capture'&&f.actions.some(a=>a.action==='searchEnter'))Object.assign(value.binding,{caretHwnd:'0',caretBelongsToWindow:false,guiFlags:0,caretRectInClient:r(0,0,0,0)});return value;};
  const pending=f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff',textEntryMode:'paste'}});await entered;await new Promise(resolve=>setImmediate(resolve));
  const enter=f.actions.findIndex(a=>a.action==='searchEnter');assert.ok(f.actions.slice(enter+1).filter(a=>a.action==='capture').length>=2);assert.ok(Number.isInteger(readyIndex));assert.equal(f.actions.some(a=>a.action==='transferFocusHandoff'),false);
  finish();const fresh=await pending;assert.equal(count,1);assert.equal(fresh.session.emptyDraftConfirmed,false);assert.equal(fresh.session.focusHwnd,'100');assert.equal(fresh.accountProof.evidence.maximumEvidenceAgeMs,500);assert.equal(f.actions.some(a=>a.action==='click'),false);assert.deepEqual(f.actions.slice(readyIndex).map(a=>a.action),['transferFocusHandoff','release']);
});

test('UIA voice refreshes its account proof after slow control checks and native release without widening the 500ms limit',async t=>{
  const f=fixture(t,withObservedPopups);f.driver.config.voice=adaptiveVoiceCalibration();let tick=Date.now(),probes=0;const checks=[],probe=f.driver.probeAccount,release=f.driver.client.release;
  f.driver.now=()=>tick;f.driver.verifyControls=async({operation})=>{checks.push(operation);tick+=600;return{verified:true,proof:'uia-controls-v1'};};
  f.driver.client.release=async()=>{const result=await release();tick+=350;return result;};
  f.driver.probeAccount=async args=>{probes++;if(probes===2){assert.deepEqual(checks,['prepare','voice-start']);assert.equal(f.actions.at(-1).action,'release');}return probe(args);};
  const fresh=await f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff',textEntryMode:'paste'}});
  assert.equal(probes,2);assert.equal(fresh.accountProof.evidence.maximumEvidenceAgeMs,500);assert.equal(Date.parse(fresh.accountProof.evidence.observedAtUtc),tick);
  validateAccountEvidence(fresh.accountProof.evidence,fresh.session,tick);await fresh.releaseFocus();assert.equal(f.actions.filter(a=>a.action==='restoreTransferredFocus').length,1);
});

test('UIA voice final proof failures restore transferred focus and cannot return a recording session',async t=>{
  for(const kind of ['expired','pid','scope','cancel']){
    const f=fixture(t,withObservedPopups);f.driver.config.voice=adaptiveVoiceCalibration();const probe=f.driver.probeAccount,abort=new AbortController();let probes=0;
    f.driver.verifyControls=async()=>({verified:true,proof:'uia-controls-v1'});
    f.driver.probeAccount=async args=>{const proof=await probe(args);if(++probes===2){assert.equal(f.actions.at(-1).action,'release');if(kind==='expired')proof.evidence.observedAtUtc=new Date(f.driver.now()-501).toISOString();if(kind==='pid')proof.evidence.processId++;if(kind==='scope')proof.accountScopeHash='b'.repeat(64);if(kind==='cancel')abort.abort();}return proof;};
    await assert.rejects(f.driver.prepareVoiceSession(f.job,{signal:abort.signal,interactionPlan:{executionMode:'focus-handoff'}}),{code:kind==='expired'?'UI_ACCOUNT_EVIDENCE_INVALID':kind==='cancel'?'UI_QT_CANCELLED':'UI_QT_ACCOUNT_UNVERIFIED'});
    assert.equal(probes,2);assert.equal(f.actions.filter(a=>a.action==='transferFocusHandoff').length,1);assert.equal(f.actions.filter(a=>a.action==='restoreTransferredFocus').length,1);
  }
});

test('adaptive shared voice refuses failed, expired or differently bound parallel account evidence without transfer',async t=>{
  for(const kind of ['failure','expired','pid','created','account','scope']){
    const f=fixture(t,withObservedPopups);f.driver.config.voice=adaptiveVoiceCalibration();const probe=f.driver.probeAccount;let count=0;
    f.driver.probeAccount=async args=>{count++;if(kind==='failure')throw Object.assign(Error('probe'),{code:'UI_ACCOUNT_PROBE_FAILED'});const proof=await probe(args);if(kind==='expired')proof.evidence.observedAtUtc=new Date(f.driver.now()-501).toISOString();if(kind==='pid')proof.evidence.processId++;if(kind==='created')proof.evidence.processCreatedFileTimeUtc='12346';if(kind==='account')proof.accountRef='b'.repeat(64);if(kind==='scope')proof.accountScopeHash='b'.repeat(64);return proof;};
    await assert.rejects(f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff',textEntryMode:'paste'}}),error=>{assert.equal(error.accountPreflightRefusal,undefined);return true;});
    assert.equal(count,1);assert.equal(f.actions.some(a=>a.action==='transferFocusHandoff'||a.action==='click'),false);assert.equal(f.actions.filter(a=>a.action==='releaseFocusHandoff').length,1);
  }
});

test('adaptive shared voice aborts and joins an in-flight probe on search transition failure or human cancellation',async t=>{
  for(const kind of ['transition','cancel']){
    const f=fixture(t,withObservedPopups);f.driver.config.voice=adaptiveVoiceCalibration();const controller=new AbortController(),request=f.driver.client.request;let started,aborted=false,settled=false;
    const entered=new Promise(resolve=>started=resolve);
    f.driver.probeAccount=async({signal})=>{started();await new Promise((resolve,reject)=>{const fail=()=>{aborted=true;reject(Object.assign(Error('aborted'),{code:'UI_ACCOUNT_PROBE_ABORTED'}));};signal.addEventListener('abort',fail,{once:true});if(signal.aborted)fail();}).finally(()=>{settled=true;});};
    if(kind==='transition')f.driver.client.request=async(action,values)=>{if(action==='capture'&&f.actions.some(a=>a.action==='searchEnter'))throw Object.assign(Error('changed'),{code:'QT_HUMAN_ACTIVITY_CHANGED',attempted:false});return request(action,values);};
    const pending=f.driver.prepareVoiceSession(f.job,{signal:controller.signal,interactionPlan:{executionMode:'focus-handoff',textEntryMode:'paste'}});await entered;if(kind==='cancel')controller.abort();await assert.rejects(pending);
    assert.equal(aborted,true);assert.equal(settled,true);assert.equal(f.actions.some(a=>a.action==='transferFocusHandoff'||a.action==='click'),false);assert.equal(f.actions.filter(a=>a.action==='searchEnter').length,1);
  }
});

test('shared text proves account before borrowing focus and retains its editor-focus flow',async t=>{
  const f=fixture(t,withObservedPopups),probe=f.driver.probeAccount;let count=0;
  f.driver.probeAccount=async args=>{count++;assert.equal(f.actions.some(a=>a.action==='beginFocusHandoff'||a.action==='searchEnter'||a.action==='capture'),false);assert.equal(f.actions.at(-1).action,'inspectLayout');return probe(args);};
  assert.equal((await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'},textEntryMode:'paste'})).ready,true);assert.equal(count,1);assert.equal(f.actions.filter(a=>a.action==='click'&&sameFixtureRect(a.rect,f.driver.config.layout.editor)).length,1);
  assert.equal(f.actions.some(a=>a.action==='parkFocusHandoff'||a.action==='resumeFocusHandoff'),false);
});

test('shared text account preflight failures never borrow focus or navigate',async t=>{
  for(const kind of ['failure','expired','pid','created','account','cancel','geometry','protocol']){
    const f=fixture(t,withObservedPopups),probe=f.driver.probeAccount,request=f.driver.client.request,abort=new AbortController();
    f.driver.client.request=async(action,input)=>{const value=await request(action,input);if(action==='inspectLayout'){if(kind==='geometry')value.binding.clientRect.right++;if(kind==='protocol')value.inputSent=true;}return value;};
    f.driver.probeAccount=async args=>{if(kind==='failure')throw Object.assign(Error('failed'),{code:'UI_ACCOUNT_PROBE_FAILED'});const proof=await probe(args);if(kind==='expired')proof.evidence.observedAtUtc=new Date(f.driver.now()-501).toISOString();if(kind==='pid')proof.evidence.processId++;if(kind==='created')proof.evidence.processCreatedFileTimeUtc='999';if(kind==='account')proof.accountRef='b'.repeat(64);if(kind==='cancel')abort.abort();return proof;};
    let value;try{value=await f.driver.prepare(f.job,{signal:abort.signal,interactionPlan:{executionMode:'focus-handoff'}});}catch{}
    assert.notEqual(value?.ready,true,kind);assert.equal(f.actions.some(a=>['beginFocusHandoff','chord','paste','click','parkFocusHandoff'].includes(a.action)),false,kind);
  }
});

test('actual background account refusal reaches a durable queue pause without input, retry or draft-intent mutation',async t=>{
  for(const kind of ['probe','native-denial','evidence'])for(const partial of [false,true]){
    const f=fixture(t,withObservedPopups),probe=f.driver.probeAccount;let probes=0;
    f.driver.probeAccount=async args=>{probes++;if(kind!=='evidence')throw Object.assign(Error('private probe detail'),{code:kind==='probe'?'UI_ACCOUNT_PROBE_FAILED':'UI_ACCOUNT_SNAPSHOT_UNSTABLE'});const proof=await probe(args);proof.evidence.observedAtUtc=new Date(f.driver.now()-501).toISOString();return proof;};
    const textDirectory=path.join(f.driver.root,'text'),directory=path.join(f.driver.root,'routes');
    const textOutbox=new UiTextOutbox({directory:textDirectory,driver:f.driver});
    const make=()=>new UiReplyOutbox({directory,textOutbox,authorize:()=>true,prepare:(job,options)=>f.driver.prepare(job,{...options,textEntryMode:'paste',interactionPlan:{executionMode:'focus-handoff'}})});
    let box=make();box.enqueue({deliveryId:f.job.id,account:f.job.account,target:f.job.target,text:f.job.text});
    const jobFile=path.join(textDirectory,'jobs',f.job.id+'.json');
    if(partial){const job=textOutbox.get(f.job.id);Object.assign(job,{state:'paused',nextActionAt:0,pendingInput:{index:0,text:'好',editorToken:'fixture',activityRevision:1}});fs.writeFileSync(jobFile,JSON.stringify(job));}
    const before=fs.readFileSync(jobFile,'utf8');await box.tick();
    assert.equal(box.stopped,false);assert.equal(box.control().paused,true);assert.equal(probes,1);assert.equal(inspectPreparationControl(directory).kind,'manual');assert.equal(inspectPreparationControl(directory).nextAttemptAt,0);
    assert.equal(inspectPreparationControl(directory).reason,kind==='probe'?'UI_ACCOUNT_PROBE_FAILED':kind==='native-denial'?'UI_ACCOUNT_SNAPSHOT_UNSTABLE':'UI_ACCOUNT_EVIDENCE_INVALID');
    assert.equal(fs.readFileSync(jobFile,'utf8'),before);if(partial)assert.deepEqual(f.driver.draftHold,{account:f.job.account,target:f.job.target});
    box.resume();await box.tick();box=make();for(let i=0;i<3;i++)await box.tick();
    assert.equal(probes,1);assert.equal(box.stopped,false);assert.equal(box.control().paused,true);assert.equal(fs.readFileSync(jobFile,'utf8'),before);
    assert.deepEqual(f.actions.map(a=>a.action),['inspectFocusHandoff','inspectLayout']);
    assert.equal(fs.readFileSync(path.join(directory,'preparation-control.json'),'utf8').includes('private probe detail'),false);
  }
});

test('account preflight pause evidence excludes other call sites, unknown failures, cancellation and cleanup uncertainty',async t=>{
  for(const kind of ['inspect-layout','later-probe','unknown','aborted','possible-input','cleanup-failed','cleanup-attempted','release-failed']){
    const f=fixture(t,withObservedPopups),controller=new AbortController();
    const error=Object.assign(Error('private failure'),{code:kind==='unknown'?'UI_INTERNAL_UNKNOWN':kind==='aborted'?'UI_ACCOUNT_PROBE_ABORTED':'UI_ACCOUNT_PROBE_FAILED',...(kind==='possible-input'?{attempted:true}:{})});
    f.driver.probeAccount=async()=>{if(kind==='aborted')controller.abort();throw error;};
    if(kind==='inspect-layout')f.setFailure('inspectLayout','UI_ACCOUNT_PROBE_FAILED');
    if(kind==='cleanup-failed')f.driver.closePreparationPopupAfterFailure=async()=>{throw Error('cleanup');};
    if(kind==='cleanup-attempted')f.driver.closePreparationPopupAfterFailure=async()=>({attempted:true,closed:true});
    if(kind==='release-failed')f.driver.releaseTextFocus=async()=>{throw Object.assign(Error('cleanup'),{code:'UI_QT_FOCUS_RETURN_UNCONFIRMED'});};
    let caught;try{await f.driver.prepare(f.job,{signal:controller.signal,...(kind==='later-probe'?{}:{interactionPlan:{executionMode:'focus-handoff'}})});}catch(error){caught=error;}
    assert.ok(caught,kind);assert.equal(caught.accountPreflightRefusal,undefined,kind);
    assert.equal(f.actions.some(a=>['paste','type','submitTextEnter'].includes(a.action)),false,kind);
  }
});

test('shared text rechecks account freshness and exact process geometry immediately after borrowing',async t=>{
  for(const kind of ['expired','pid','created','hwnd','dpi','width','position']){
    const f=fixture(t,withObservedPopups),request=f.driver.client.request;let now=Date.now(),borrowed=false;f.driver.now=()=>now;
    f.driver.client.request=async(action,input)=>{const value=await request(action,input);if(action==='beginFocusHandoff'){borrowed=true;if(kind==='expired')now+=501;}if(action==='capture'&&borrowed){if(kind==='pid')value.binding.pid++;if(kind==='created')value.binding.processCreatedFileTimeUtc='999';if(kind==='hwnd')value.binding.hwnd='101';if(kind==='dpi')value.binding.dpi++;if(kind==='width'){value.binding.clientRect={...value.binding.clientRect,right:801};value.binding.captureRect={...value.binding.captureRect,right:811};}if(kind==='position')value.binding.captureRect={...value.binding.captureRect,left:11,right:811};}return value;};
    let value;try{value=await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}});}catch(error){assert.equal(error.accountPreflightRefusal,undefined,kind);}
    assert.notEqual(value?.ready,true,kind);assert.equal(f.actions.filter(a=>a.action==='beginFocusHandoff').length,1,kind);assert.equal(f.actions.filter(a=>a.action==='releaseFocusHandoff').length,1,kind);assert.equal(f.actions.some(a=>['chord','paste','click','parkFocusHandoff'].includes(a.action)),false,kind);
  }
});

test('human activity after background account inspection remains a definite pre-focus refusal',async t=>{
  const f=fixture(t,withObservedPopups),probe=f.driver.probeAccount;
  f.driver.probeAccount=async args=>{const proof=await probe(args);f.setFailure('beginFocusHandoff','QT_HUMAN_ACTIVITY_CHANGED');return proof;};
  assert.deepEqual(await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}}),{ready:false,reason:'QT_HUMAN_ACTIVITY_CHANGED'});
  assert.equal(f.actions.some(a=>a.action==='capture'||a.action==='chord'||a.action==='paste'||a.action==='click'),false);
});
test('shared voice preparation refusal releases owned focus without starting recording',async t=>{
  const f=fixture(t);f.driver.config.voice=voiceCalibration();f.setFailure('capture','QT_USER_ACTIVE');
  await assert.rejects(f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff'}}),{code:'QT_USER_ACTIVE'});
  assert.deepEqual(f.actions.map(a=>a.action),['beginFocusHandoff','capture','releaseFocusHandoff']);
});

test('voice session uses the final guarded input tick after Qt restores its pointer',async t=>{
  const f=fixture(t);f.driver.config.voice=voiceCalibration();const original=f.driver.client.request;
  f.driver.client.request=async(action,values)=>{const result=await original(action,values);if(action==='transferFocusHandoff')result.cleanup.lastInputTick=7319;return result;};
  const fresh=await f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff'}});
  assert.equal(fresh.session.lastInputTick,7319);assert.deepEqual(f.actions.slice(-2).map(a=>a.action),['transferFocusHandoff','release']);
  await fresh.releaseFocus();assert.equal(f.actions.at(-1).cleanup.lastInputTick,7319);
});

test('voice focus transfer tolerates one Windows clock tick but rejects a further future or expired native timestamp',async t=>{
  for(const delta of [-30001,1,16,17]){
    const f=fixture(t);f.driver.config.voice=voiceCalibration();const now=Date.now(),request=f.driver.client.request;f.driver.now=()=>now;
    f.driver.client.request=async(action,values)=>{const result=await request(action,values);if(action==='transferFocusHandoff')result.cleanup.issuedAtMs=now+delta;return result;};
    if(delta>=0&&delta<=16){const fresh=await f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff'}});assert.ok(fresh.focusHandoff);await fresh.releaseFocus();}
    else await assert.rejects(f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff'}}),error=>error.code==='UI_QT_FOCUS_LEASE_INVALID'&&error.focusTransferValidation.ageMs===-delta&&error.focusTransferValidation.ageValid===false);
  }
});

test('a transferred final input tick cannot bypass the frame revision, window identity or token lifetime',async t=>{
  for(const [change,cleanupAvailable] of [[x=>x.revision++,true],[x=>x.cleanup.wechatWindow.pid++,false],[x=>x.cleanup.returnWindow.hwnd='201',false],[x=>x.cleanup.lastInputTick=-1,false],[x=>x.cleanup.lastInputTick=0x100000000,false],[x=>x.cleanup.issuedAtMs-=30001,true],[x=>x.cleanup.extra=true,false]]){
    const f=fixture(t);f.driver.config.voice=voiceCalibration();const original=f.driver.client.request;
    f.driver.client.request=async(action,values)=>{const result=await original(action,values);if(action==='transferFocusHandoff')change(result);if(action==='restoreTransferredFocus'&&Date.now()-values.cleanup.issuedAtMs>30000)throw Object.assign(Error('expired'),{code:'QT_FOCUS_LEASE_EXPIRED'});return result;};
    await assert.rejects(f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff'}}),error=>{
      const diagnostic=error.focusTransferValidation;assert.equal(diagnostic.valid,false);assert.equal(diagnostic.cleanupAvailable,cleanupAvailable);
      assert.equal(error.code,cleanupAvailable&&diagnostic.ageValid?'UI_QT_FOCUS_LEASE_INVALID':'UI_QT_FOCUS_RETURN_UNCONFIRMED');return true;
    });
    assert.equal(f.actions.some(a=>a.action==='release'),false);
    assert.equal(f.actions.filter(a=>a.action==='restoreTransferredFocus').length,cleanupAvailable?1:0);assert.equal(f.actions.some(a=>a.action==='releaseFocusHandoff'),false);
  }
});

test('invalid transferred session metadata still restores through its original helper before releasing the native mutex',async t=>{
  for(const kind of ['handoff-shape','handoff-return','revision']){
    const f=fixture(t);f.driver.config.voice=voiceCalibration();const request=f.driver.client.request;let rollback=0;
    f.driver.clientFactory=()=>{throw Error('must reuse the owner while its mutex is held');};
    f.driver.client.request=async(action,values)=>{const result=await request(action,values);if(action==='transferFocusHandoff'){if(kind==='handoff-shape')result.focusHandoff.privateDetail='must-not-leak';if(kind==='handoff-return')result.focusHandoff.returnWindow.hwnd='201';if(kind==='revision')result.revision++;}
      if(action==='restoreTransferredFocus'){rollback++;assert.equal(values.cleanup.returnWindow.hwnd,'200');}return result;};
    await assert.rejects(f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff'}}),error=>{
      assert.equal(error.code,'UI_QT_FOCUS_LEASE_INVALID');assert.equal(error.focusTransferValidation.cleanupAvailable,true);assert.equal(error.focusTransferValidation.valid,false);assert.equal(JSON.stringify(error.focusTransferValidation).includes('must-not-leak'),false);
      if(kind==='handoff-shape')assert.equal(error.focusTransferValidation.handoffValid,false);if(kind==='handoff-return')assert.equal(error.focusTransferValidation.handoffMatchesOriginal,false);if(kind==='revision')assert.equal(error.focusTransferValidation.revisionMatches,false);return true;
    });
    assert.equal(rollback,1);assert.equal(f.actions.some(a=>a.action==='releaseFocusHandoff'||a.action==='release'),false);assert.equal(f.driver.voiceFocusLease,null);
  }
});

test('failed transferred rollback reports cleanup uncertainty with the original validation diagnostics',async t=>{
  const f=fixture(t);f.driver.config.voice=voiceCalibration();const request=f.driver.client.request;
  f.driver.client.request=async(action,values)=>{const result=await request(action,values);if(action==='transferFocusHandoff')result.revision++;if(action==='restoreTransferredFocus')throw Object.assign(Error('private native error'),{code:'QT_FOCUS_RETURN_UNCONFIRMED'});return result;};
  await assert.rejects(f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff'}}),error=>{assert.equal(error.code,'UI_QT_FOCUS_RETURN_UNCONFIRMED');assert.equal(error.focusTransferValidation.revisionMatches,false);assert.equal(error.focusTransferValidation.cleanupAvailable,true);return true;});
  assert.equal(f.actions.filter(a=>a.action==='restoreTransferredFocus').length,1);assert.equal(f.actions.some(a=>a.action==='releaseFocusHandoff'),false);
});
test('shared voice final account failure stays parked without transfer or a usable session',async t=>{
  const f=fixture(t);f.driver.config.voice=voiceCalibration();const original=f.driver.probeAccount;let probes=0;
  f.driver.probeAccount=async args=>{if(++probes===2)throw Object.assign(new Error('expired'),{code:'UI_QT_ACCOUNT_UNVERIFIED'});return original(args);};
  await assert.rejects(f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff'}}),{code:'UI_QT_ACCOUNT_UNVERIFIED'});
  assert.equal(f.actions.at(-1).action,'releaseFocusHandoff');assert.equal(f.actions.some(a=>a.action==='transferFocusHandoff'),false);
});

test('shared profile OCR and exact database checks overlap while focus is parked',async t=>{
  const f=fixture(t),recognize=f.driver.recognize,verify=f.driver.verifyContact;
  let startOcr,startDb,finishOcr,finishDb;
  const ocrStarted=new Promise(resolve=>{startOcr=resolve;}),dbStarted=new Promise(resolve=>{startDb=resolve;});
  const ocrGate=new Promise(resolve=>{finishOcr=resolve;}),dbGate=new Promise(resolve=>{finishDb=resolve;});
  f.driver.recognize=async args=>{assert.equal(f.actions.at(-1).action,'parkFocusHandoff');startOcr();await ocrGate;return recognize(args);};
  f.driver.verifyContact=async args=>{assert.equal(f.actions.at(-1).action,'parkFocusHandoff');startDb();await dbGate;return verify(args);};
  const pending=f.driver.prepare(f.job,{interactionPlan:{sendMode:'focus-handoff'},textEntryMode:'paste'});
  await Promise.all([ocrStarted,dbStarted]);const before=f.actions.length;
  finishOcr();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.actions.length,before);
  finishDb();assert.equal((await pending).ready,true);
  assert.equal(f.actions.filter(item=>item.action==='readDraft').length,1);
  const release=await f.driver.releaseTextFocus();assert.ok(release.foregroundIntervals.some(item=>item.phase==='contact-navigation'));
  assert.ok(release.foregroundIntervals.every(item=>item.complete===true));
});

test('background OCR failure never reacquires focus and only retires the parked lease',async t=>{
  const f=fixture(t);f.driver.recognize=async()=>{throw Object.assign(Error('offline'),{code:'VISUAL_UNAVAILABLE'});};
  await assert.rejects(f.driver.prepare(f.job,{interactionPlan:{sendMode:'focus-handoff'}}),{code:'VISUAL_UNAVAILABLE'});
  const park=f.actions.findLastIndex(item=>item.action==='parkFocusHandoff');
  assert.deepEqual(f.actions.slice(park+1).map(item=>item.action),['releaseFocusHandoff']);
  assert.equal(f.driver.current,null);
});

test('human activity during parked identity work invalidates the original transaction',async t=>{
  const f=fixture(t),recognize=f.driver.recognize;
  f.driver.recognize=async args=>{f.setRevision(1);return recognize(args);};
  const result=await f.driver.prepare(f.job,{interactionPlan:{sendMode:'focus-handoff'}});
  assert.deepEqual(result,{ready:false,reason:'QT_HUMAN_ACTIVITY_CHANGED'});
  const resume=f.actions.findLastIndex(item=>item.action==='resumeFocusHandoff');
  assert.deepEqual(f.actions.slice(resume+1).map(item=>item.action),['releaseFocusHandoff']);
  assert.equal(f.actions.some(item=>item.action==='readDraft'),false);
});

test('cancellation during parked work stops without resume or further navigation',async t=>{
  const f=fixture(t),abort=new AbortController(),recognize=f.driver.recognize;
  f.driver.recognize=async args=>{abort.abort();return recognize(args);};
  await assert.rejects(f.driver.prepare(f.job,{signal:abort.signal,interactionPlan:{sendMode:'focus-handoff'}}),{code:'UI_QT_CANCELLED'});
  const park=f.actions.findLastIndex(item=>item.action==='parkFocusHandoff');
  assert.equal(f.actions.slice(park+1).some(item=>['resumeFocusHandoff','click','chord','paste','readDraft'].includes(item.action)),false);
  assert.equal(f.driver.current,null);
});

test('resume requires original return identity, transaction and unchanged header',async t=>{
  for(const mode of ['return','revision','header']){
    const f=fixture(t),request=f.driver.client.request;
    f.driver.client.request=async(action,values)=>{const result=await request(action,values);if(action==='resumeFocusHandoff'){
      if(mode==='return')result.focusHandoff.returnWindow.hwnd='201';
      if(mode==='revision')f.setRevision(1);
      if(mode==='header')f.setHeader('f'.repeat(64));
    }return result;};
    if(mode==='revision')assert.deepEqual(await f.driver.prepare(f.job,{interactionPlan:{sendMode:'focus-handoff'}}),{ready:false,reason:'UI_QT_HUMAN_ACTIVITY_CHANGED'});
    else await assert.rejects(f.driver.prepare(f.job,{interactionPlan:{sendMode:'focus-handoff'}}),{code:mode==='return'?'UI_QT_FOCUS_LEASE_INVALID':'UI_QT_HEADER_CHANGED'});
    assert.equal(f.actions.some(item=>item.action==='readDraft'),false);
  }
});

test('shared voice returns focus after its only draft copy and binds a fresh no-copy final session',async t=>{
  const f=fixture(t);f.driver.config.voice=voiceCalibration();
  const probe=f.driver.probeAccount;f.driver.probeAccount=async args=>{assert.equal(f.actions.at(-1).action,'parkFocusHandoff');return probe(args);};
  const fresh=await f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff',textEntryMode:'paste'}});
  const copy=f.actions.findLastIndex(item=>item.action==='readDraft'),transfer=f.actions.findIndex(item=>item.action==='transferFocusHandoff');
  const final=f.actions.slice(copy+1,transfer).map(item=>item.action);
  assert.ok(final.includes('parkFocusHandoff'));assert.ok(final.includes('resumeFocusHandoff'));
  assert.equal(f.actions.filter(item=>item.action==='readDraft').length,1);
  assert.equal(final.some(action=>['chord','click','paste','type'].includes(action)),false);
  assert.equal(fresh.focusHandoff.foregroundLease.includesContactNavigation,false);
  assert.ok(fresh.foregroundIntervals.length>1);assert.ok(fresh.foregroundIntervals.some(item=>item.includesContactNavigation));
  assert.equal(fresh.session.emptyDraftConfirmed,true);assert.ok(fresh.session.expiresAtMs>fresh.session.issuedAtMs);
});
test('shared voice accepts only complete empty image phases verified by its own successful draft copy',async t=>{
  const f=fixture(t,c=>{c.layout.emptyEditorSha256='e'.repeat(64);c.layout.emptyEditorSha256s=['e'.repeat(64),'c'.repeat(64)];});f.driver.config.voice=voiceCalibration();
  const request=f.driver.client.request,probe=f.driver.probeAccount;let finalProbe=false;
  f.driver.probeAccount=async args=>{const result=await probe(args);if(f.actions.some(item=>item.action==='readDraft'))finalProbe=true;return result;};
  f.driver.client.request=async(action,values)=>{const result=await request(action,values);if(finalProbe&&action==='capture'&&values.regions.length===2)result.regions[1].rgbaSha256='c'.repeat(64);return result;};
  const result=await f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff'}});assert.equal(result.session.emptyDraftConfirmed,true);assert.equal(f.actions.filter(item=>item.action==='readDraft').length,1);
  assert.equal(qtEmptyEditorPhaseMatches('e'.repeat(64),'c'.repeat(64),['e'.repeat(64),'c'.repeat(64)]),true);
  assert.equal(qtEmptyEditorPhaseMatches('e'.repeat(64),'f'.repeat(64),['e'.repeat(64),'c'.repeat(64)]),false);
});
test('post-copy configuration edits, missing proof, changed headers and changed transactions cannot approve another empty phase',async t=>{
  for(const mode of ['config-only','missing-proof','header','revision']){
    const f=fixture(t,c=>{c.layout.emptyEditorSha256='e'.repeat(64);c.layout.emptyEditorSha256s=mode==='config-only'?['e'.repeat(64)]:['e'.repeat(64),'c'.repeat(64)];});f.driver.config.voice=voiceCalibration();
    const probe=f.driver.probeAccount,request=f.driver.client.request;let finalProbe=false;
    f.driver.probeAccount=async args=>{const result=await probe(args);if(f.actions.some(item=>item.action==='readDraft')){finalProbe=true;if(mode==='config-only')f.driver.config.layout.emptyEditorSha256s.push('c'.repeat(64));if(mode==='missing-proof')delete f.driver.current.verifiedEmptyHashes;if(mode==='header')f.setHeader('f'.repeat(64));if(mode==='revision')f.setRevision(1);}return result;};
    f.driver.client.request=async(action,values)=>{const result=await request(action,values);if(finalProbe&&action==='capture'&&values.regions.length===2)result.regions[1].rgbaSha256='c'.repeat(64);return result;};
    await assert.rejects(f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff'}}));assert.equal(f.actions.some(item=>item.action==='transferFocusHandoff'),false);
  }
});
function nativePhaseFixture(t){
  const f=fixture(t);f.driver.config.voice=voiceCalibration();const request=f.driver.client.request,probe=f.driver.probeAccount;
  let afterPark=false,actual='e'.repeat(64);const proof={version:1,id:'9'.repeat(32),editorRect:f.driver.config.layout.editor,knownEmptySha256s:['c'.repeat(64)]};
  f.driver.probeAccount=async args=>{const result=await probe(args);if(f.actions.some(item=>item.action==='readDraft'))afterPark=true;return result;};
  f.driver.client.request=async(action,values)=>{
    const result=await request(action,values);
    if(action==='readDraft'){result.emptyDraftPhaseProof=proof;result.richContentVerified=true;}
    if(action==='capture'&&values.regions.length===2){actual=afterPark?'f'.repeat(64):'e'.repeat(64);result.regions[1].rgbaSha256=actual;}
    if(action==='inspectEmptyEditorPhase')return{version:1,emptyDraftPhaseVerified:true,proofId:proof.id,actualRgbaSha256:actual,normalizedRgbaSha256:'c'.repeat(64),caretRemoved:true,revision:values.revision,readOnly:true,inputSent:false};
    return result;
  };return f;
}
test('single-template voice uses only native transaction-bound full-image caret proofs before and after parked work',async t=>{
  const f=nativePhaseFixture(t);const result=await f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff'}});
  assert.equal(result.session.emptyDraftConfirmed,true);assert.equal(f.actions.filter(item=>item.action==='readDraft').length,1);assert.equal(f.actions.filter(item=>item.action==='inspectEmptyEditorPhase').length,2);
  const copyIndex=f.actions.findIndex(item=>item.action==='readDraft');assert.equal(f.actions[copyIndex-1].action,'capture');assert.deepEqual(f.actions[copyIndex-1].regions,[f.driver.config.layout.header]);
  const editorClick=f.actions.findLastIndex((item,index)=>index<copyIndex&&item.action==='click'&&JSON.stringify(item.rect)===JSON.stringify(f.driver.config.layout.editor));assert.ok(editorClick>=0);
  const beforeCopy=f.actions.slice(editorClick+1,copyIndex).filter(item=>item.action==='capture');assert.ok(beforeCopy.length>0);
  for(const item of beforeCopy)assert.equal(item.regions.some(rect=>JSON.stringify(rect)===JSON.stringify(f.driver.config.layout.editor)),false,'pre-copy focus/park observations must not anchor an unverified blinking caret');
  assert.equal(f.driver.config.layout.emptyEditorSha256,'c'.repeat(64));assert.equal(f.driver.config.layout.emptyEditorSha256s,undefined);
});
test('native phase proof mismatches, unsafe flags and unverified rich content cannot issue a voice session',async t=>{
  for(const mode of ['actual','normalized','revision','proof','readOnly','inputSent','rich','unbound-proof','extra']){
    const f=nativePhaseFixture(t),request=f.driver.client.request;
    f.driver.client.request=async(action,values)=>{const result=await request(action,values);if(action==='readDraft'){if(mode==='rich')result.richContentVerified=false;if(mode==='unbound-proof')result.emptyDraftPhaseProof={...result.emptyDraftPhaseProof,knownEmptySha256s:['d'.repeat(64)]};}
      if(action==='inspectEmptyEditorPhase'){if(mode==='actual')result.actualRgbaSha256='0'.repeat(64);if(mode==='normalized')result.normalizedRgbaSha256='0'.repeat(64);if(mode==='revision')result.revision++;if(mode==='proof')result.proofId='0'.repeat(32);if(mode==='readOnly')result.readOnly=false;if(mode==='inputSent')result.inputSent=true;if(mode==='extra')result.extra=true;}return result;};
    await assert.rejects(f.driver.prepareVoiceSession(f.job,{interactionPlan:{executionMode:'focus-handoff'}}));assert.equal(f.actions.some(item=>item.action==='transferFocusHandoff'),false);
  }
});

test('draft or cancellation changes after the parked final voice check never transfer a session',async t=>{
  for(const mode of ['editor','cancel']){
    const f=fixture(t);f.driver.config.voice=voiceCalibration();const abort=new AbortController(),probe=f.driver.probeAccount;let probes=0;
    f.driver.probeAccount=async args=>{const result=await probe(args);if(++probes===2){if(mode==='cancel')abort.abort();else f.setDraft('unrelated draft');}return result;};
    if(mode==='editor'){
      const request=f.driver.client.request;f.driver.client.request=async(action,values)=>{const result=await request(action,values);if(probes===2&&action==='capture'&&values.regions.length===2)result.regions[1].rgbaSha256='f'.repeat(64);return result;};
    }
    await assert.rejects(f.driver.prepareVoiceSession(f.job,{signal:abort.signal,interactionPlan:{executionMode:'focus-handoff'}}),{code:mode==='cancel'?'UI_QT_CANCELLED':'UI_QT_DRAFT_CHANGED'});
    assert.equal(f.actions.some(item=>item.action==='transferFocusHandoff'),false);
    assert.equal(f.actions.filter(item=>item.action==='readDraft').length,1);
  }
});

test('lease timing shape is strict and legacy native reports never invent complete intervals',async t=>{
  for(const mutate of [value=>value.extra=true,value=>value.foregroundLease.extra=true,value=>value.foregroundLease.startedAtTickMs=0,value=>value.foregroundLease.includesContactNavigation='yes']){
    const f=fixture(t),request=f.driver.client.request;
    f.driver.client.request=async(action,values)=>{const result=await request(action,values);if(action==='beginFocusHandoff')mutate(result.focusHandoff);return result;};
    await assert.rejects(f.driver.prepare(f.job,{interactionPlan:{sendMode:'focus-handoff'}}),{code:'UI_QT_FOCUS_LEASE_INVALID'});
  }
  const f=fixture(t),request=f.driver.client.request;
  f.driver.client.request=async(action,values)=>{const result=await request(action,values);delete result.foregroundInterval;return result;};
  assert.equal((await f.driver.prepare(f.job,{interactionPlan:{sendMode:'focus-handoff'}})).ready,true);
  assert.equal((await f.driver.releaseTextFocus()).foregroundIntervals,undefined);
});

test('skipped and failed final focus restoration record incomplete timing without changing cleanup outcomes',async t=>{
  for(const mode of ['skipped','exception']){
    const f=fixture(t);assert.equal((await f.driver.prepare(f.job,{interactionPlan:{sendMode:'focus-handoff'}})).ready,true);
    const interval={phase:'preparation',durationMs:350,includesContactNavigation:false,complete:true};
    const focusRestoreOutcome={version:1,reason:mode==='exception'?'restore-confirmation-failed':'activity-changed',restored:mode==='exception'?null:false,skipped:mode!=='exception',foregroundOwnedByWechat:true,identitiesUnchanged:true,activityUnchanged:mode==='exception',keysReleased:true,parkRevisionUnchanged:null};
    if(mode==='exception')f.setFailure('releaseFocusHandoff','QT_FOCUS_RETURN_UNCONFIRMED',{foregroundInterval:interval,focusRestoreOutcome});
    else{
      const request=f.driver.client.request;
      f.driver.client.request=async(action,values)=>{const result=await request(action,values);return action==='releaseFocusHandoff'?{restored:false,skipped:true,foregroundInterval:interval,focusRestoreOutcome}:result;};
    }
    if(mode==='exception')await assert.rejects(f.driver.releaseTextFocus(),error=>{assert.deepEqual(error.focusRestoreOutcome,focusRestoreOutcome);return error.code==='UI_QT_FOCUS_RETURN_UNCONFIRMED'&&error.foregroundIntervals.at(-1).complete===false;});
    else{const result=await f.driver.releaseTextFocus();assert.equal(result.released,true);assert.equal(result.restored,false);assert.equal(result.skipped,true);assert.equal(result.foregroundIntervals.at(-1).complete,false);assert.deepEqual(result.focusRestoreOutcome,focusRestoreOutcome);}
    const saved=readForegroundTimings({root:f.driver.root}).measurements.find(item=>item.operation==='text');
    assert.equal(saved.complete,false);assert.equal(saved.maxContinuousForegroundMs,null);assert.equal(saved.intervals.at(-1).durationMs,350);
    assert.equal(f.actions.filter(item=>item.action==='releaseFocusHandoff').length,1);
  }
});

test('preparation park failure preserves the origin return outcome and never resumes or continues input',async t=>{
  const focusRestoreOutcome={version:1,reason:'keys-held',restored:false,skipped:true,foregroundOwnedByWechat:true,identitiesUnchanged:true,activityUnchanged:true,keysReleased:false,parkRevisionUnchanged:null};
  for(const mode of ['native-error','skipped-result']){
    const f=fixture(t);const interval={phase:'preparation',durationMs:78,includesContactNavigation:false,complete:false};
    if(mode==='native-error')f.setFailure('parkFocusHandoff','QT_FOCUS_RETURN_UNCONFIRMED',{focusRestoreOutcome,foregroundInterval:interval});
    else{const request=f.driver.client.request;f.driver.client.request=async(action,values)=>{const result=await request(action,values);return action==='parkFocusHandoff'?{restored:false,skipped:true,focusRestoreOutcome,foregroundInterval:interval}:result;};}
    await assert.rejects(f.driver.prepare(f.job,{interactionPlan:{sendMode:'focus-handoff'}}),error=>{assert.deepEqual(error.focusRestoreOutcome,focusRestoreOutcome);assert.deepEqual(error.foregroundInterval,interval);return error.code===(mode==='native-error'?'QT_FOCUS_RETURN_UNCONFIRMED':'UI_QT_FOCUS_RETURN_UNCONFIRMED');});
    const at=f.actions.findIndex(item=>item.action==='parkFocusHandoff');assert.ok(at>=0);assert.deepEqual(f.actions.slice(at+1).map(item=>item.action),['releaseFocusHandoff']);
  }
});

test('unsupported return captions wait before borrowing focus while uncertain return input remains fatal',async t=>{
  for(const code of ['QT_RETURN_CAPTION_UNAVAILABLE','QT_RETURN_CAPTION_WARMUP']){
    const f=fixture(t);f.setFailure('beginFocusHandoff',code);
    assert.deepEqual(await f.driver.prepare(f.job,{interactionPlan:{sendMode:'focus-handoff'}}),{ready:false,reason:code,attempted:false,focusPreflightClean:true});
    assert.equal(f.actions.some(item=>['click','type','paste','readDraft','parkFocusHandoff','resumeFocusHandoff','releaseFocusHandoff'].includes(item.action)),false);
  }
  for(const code of ['QT_RETURN_CAPTION_INPUT_UNCERTAIN','QT_RETURN_CAPTION_ALREADY_ATTEMPTED','QT_RETURN_CAPTION_CHANGED']){
    const f=fixture(t);f.setFailure('parkFocusHandoff',code);
    await assert.rejects(f.driver.prepare(f.job,{interactionPlan:{sendMode:'focus-handoff'}}),{code});
    assert.equal(f.actions.some(item=>item.action==='resumeFocusHandoff'),false);
  }
});

test('return-caption wait evidence belongs only to a clean pre-focus attempt',async t=>{
  const code='QT_RETURN_CAPTION_UNAVAILABLE';
  for(const change of [
    f=>f.setFailure('beginFocusHandoff',code,{attempted:true}),
    f=>f.setFailure('beginFocusHandoff',code,{attempted:false,clipboardRestored:false}),
    f=>{f.job.index=1;f.setFailure('beginFocusHandoff',code);},
    f=>{f.job.pendingInput={index:0};f.setFailure('beginFocusHandoff',code);},
    f=>f.setFailure('parkFocusHandoff',code),
  ]){
    const f=fixture(t);change(f);
    let result;
    try{result=await f.driver.prepare(f.job,{interactionPlan:{sendMode:'focus-handoff'}});}
    catch(error){result=error;}
    assert.notEqual(result.focusPreflightClean,true);
  }
  const f=fixture(t),request=f.driver.client.request;
  f.driver.client.request=async(action,input)=>action==='inspectFocusHandoff'
    ?{ready:false,reason:code,inputSent:false,clipboardAccessed:false,focusChanged:false}
    :request(action,input);
  assert.deepEqual(await f.driver.prepare(f.job,{interactionPlan:{sendMode:'focus-handoff'}}),
    {ready:false,reason:code,attempted:false,focusPreflightClean:true});
  assert.equal(f.actions.some(row=>row.action==='beginFocusHandoff'),false);
});
test('clipboard entry pastes complete search once and keeps exact contact verification',async t=>{
  const f=fixture(t);await f.driver.prepare(f.job,{textEntryMode:'paste'});
  assert.equal(f.actions.filter(a=>a.action==='type').length,0);
  const paste=f.actions.find(a=>a.action==='paste');assert.equal(paste.scope,'search');assert.equal(paste.text,'target_A');assert.equal(paste.expectedText,'target_A');
  const state=await f.driver.observe(f.job);assert.equal(state.ready,true);
  const result=await f.driver.pasteText(f.job,{expectedDraft:'',editorToken:state.editorToken,activityRevision:state.activityRevision,text:'你好\n测试'},{canInput:()=>true});
  assert.equal(result.performed,true);assert.equal((await f.driver.observe(f.job)).draft,'你好\n测试');
  assert.equal(f.actions.filter(a=>a.action==='paste'&&a.scope==='editor').length,1);
});
test('paste rechecks local authorization after async account observation and refuses without input',async t=>{
  const f=fixture(t);await f.driver.prepare(f.job);const state=await f.driver.observe(f.job);let allowed=true;
  const previous=f.driver.probeAccount;f.driver.probeAccount=async args=>{allowed=false;return previous(args);};const before=f.actions.length;
  const result=await f.driver.pasteText(f.job,{expectedDraft:'',editorToken:state.editorToken,activityRevision:state.activityRevision,text:'完整文字'},{canInput:()=>allowed});
  assert.equal(result.attempted,false);assert.equal(result.reason,'UI_TARGET_NOT_ALLOWED');assert.equal(f.actions.slice(before).some(a=>a.action==='paste'),false);
});

test('type requires a local authorization callback and never serializes it to native requests',async t=>{
  const f=fixture(t);await f.driver.prepare(f.job);const state=await f.driver.observe(f.job);
  const guard={expectedDraft:'',editorToken:state.editorToken,activityRevision:state.activityRevision,text:'好'};
  const before=f.actions.length;
  assert.equal((await f.driver.typeGrapheme(f.job,guard)).reason,'UI_QT_INPUT_AUTHORIZATION_REQUIRED');
  assert.equal(f.actions.slice(before).some(a=>a.action==='type'),false);
  assert.equal((await f.driver.typeGrapheme(f.job,guard,{canInput:()=>true})).performed,true);
  const action=f.actions.slice(before).find(a=>a.action==='type');assert.equal(Object.hasOwn(action,'canInput'),false);
  assert.equal(Object.values(action).some(value=>typeof value==='function'),false);
});

test('target removal during delayed account proof reaches the final type guard through selection and receipt wrappers',async t=>{
  const f=fixture(t);await f.driver.prepare(f.job);const state=await f.driver.observe(f.job);let allowed=true,release,entered;
  const inProof=new Promise(resolve=>{entered=resolve;}),blocked=new Promise(resolve=>{release=resolve;}),previous=f.driver.probeAccount;
  f.driver.probeAccount=async args=>{entered();await blocked;return previous(args);};
  const driver=createSelectionGuardedDriver({store:{authorizeDelivery:()=>allowed},driver:createReceiptUiDriver({native:f.driver,receipts:{},inputAllowed:()=>true})});
  const before=f.actions.length,pending=driver.typeGrapheme(f.job,{expectedDraft:'',editorToken:state.editorToken,activityRevision:state.activityRevision,text:'好',canInput:()=>true});
  await inProof;allowed=false;release();
  assert.deepEqual(await pending,{performed:false,attempted:false,reason:'UI_TARGET_NOT_ALLOWED'});
  assert.equal(f.actions.slice(before).some(a=>a.action==='type'),false);
});

test('type authorization revoked during final async observation prevents native input',async t=>{
  const f=fixture(t);await f.driver.prepare(f.job);const state=await f.driver.observe(f.job);let allowed=true;
  const previous=f.driver.observe.bind(f.driver);f.driver.observe=async job=>{const result=await previous(job);allowed=false;return result;};const before=f.actions.length;
  const result=await f.driver.typeGrapheme(f.job,{expectedDraft:'',editorToken:state.editorToken,activityRevision:state.activityRevision,text:'好'},{canInput:()=>allowed});
  assert.equal(result.attempted,false);assert.equal(result.reason,'UI_TARGET_NOT_ALLOWED');assert.equal(f.actions.slice(before).some(a=>a.action==='type'),false);
});
test('unverified paste is uncertain and is never retried by the Qt driver',async t=>{
  const f=fixture(t);await f.driver.prepare(f.job);const state=await f.driver.observe(f.job);f.setFailure('paste','QT_PASTE_READBACK_UNCONFIRMED',{attempted:true,clipboardRestored:true});
  await assert.rejects(f.driver.pasteText(f.job,{expectedDraft:'',editorToken:state.editorToken,activityRevision:state.activityRevision,text:'完整文字'},{canInput:()=>true}),{code:'QT_PASTE_READBACK_UNCONFIRMED'});
  assert.equal(f.actions.filter(a=>a.action==='paste').length,1);assert.equal(f.driver.current,null);
});
test('foreground, activity, occlusion and stale pixels pause preparation without retaining a session',async t=>{
  for(const code of ['DRAFT_EXECUTABLE_MISMATCH','DRAFT_WINDOW_NOT_FOREGROUND','DRAFT_KEYS_HELD','DRAFT_DESKTOP_UNAVAILABLE','QT_HUMAN_ACTIVITY_CHANGED','QT_ACTIVITY_WARMUP','QT_USER_ACTIVE','QT_WINDOW_OBSCURED','QT_PIXELS_CHANGED','QT_OBSERVATION_CHANGED']){
    const f=fixture(t);f.setFailure('capture',code);
    assert.deepEqual(await f.driver.prepare(f.job),{ready:false,reason:code});
    assert.equal(f.driver.current,null);assert.equal(f.driver.frame,null);assert.equal(f.driver.transaction,null);
    assert.deepEqual(f.actions.map(action=>action.action),Array(code==='QT_PIXELS_CHANGED'?4:1).fill('capture'));
  }
});

test('caret snapshot retry never repeats input and draft read remains fully verified',async t=>{
  const f=fixture(t),original=f.driver.client.request.bind(f.driver.client);let refused=false;
  f.driver.client.request=async(action,values)=>{if(action==='capture'&&!refused){refused=true;throw Object.assign(new Error('blink'),{code:'QT_PIXELS_CHANGED',attempted:false});}return original(action,values);};
  assert.equal((await f.driver.prepare(f.job)).ready,true);
  const reads=f.actions.map((value,index)=>({value,index})).filter(({value})=>value.action==='readDraft');
  assert.ok(reads.length>0);
  for(const {index} of reads)assert.deepEqual(f.actions[index-1].regions,[f.driver.config.layout.header]);
  assert.equal(f.actions.filter(a=>a.action==='click'&&JSON.stringify(a.rect)===JSON.stringify(f.driver.config.layout.selfOpen)).length,1);
});

test('identity, structure and uncertain clipboard restoration still fail rather than wait',async t=>{
  for(const code of ['UI_QT_ACCOUNT_UNVERIFIED','UI_QT_PROFILE_ID_UNVERIFIED','UI_QT_OBSERVATION_INVALID','QT_RICH_DRAFT_UNSUPPORTED','DRAFT_CLIPBOARD_RESTORE_UNCONFIRMED','UI_QT_CLEANUP_UNCONFIRMED']){
    const f=fixture(t);f.setFailure('capture',code);await assert.rejects(f.driver.prepare(f.job),{code});
  }
  const f=fixture(t);f.setFailure('readDraft','QT_HUMAN_ACTIVITY_CHANGED',{attempted:true});
  await assert.rejects(f.driver.prepare(f.job),{code:'UI_QT_CLEANUP_UNCONFIRMED'});
});

test('interruption after navigation leaves the bridge running and later ticks waiting without duplicate text',async t=>{
  const f=fixture(t);let changed=false;
  f.driver.wait=async()=>{if(!changed&&f.actions.some(action=>action.action==='click')){changed=true;f.setRevision(1);}};
  const backend=new UiOneBotBackend({directory:path.join(f.driver.root,'bridge'),policy:{accountWxid:f.job.account,targets:[{kind:'private',id:uiOneBotId(f.job.target),wxid:f.job.target}]},driver:f.driver,settings:{idleMs:10,intervalMs:0,punctuationPauseMs:0}});
  backend.outbox.enqueue({deliveryId:f.job.id,account:f.job.account,target:f.job.target,text:f.job.text});
  await backend.tick();assert.equal(backend.stopped,false);assert.equal(backend.outbox.get(f.job.id).index,0);
  assert.equal(f.actions.filter(action=>action.action==='click').length,1);
  assert.equal(f.actions.some(action=>action.action==='type'),false);
  f.setFailure('capture','DRAFT_WINDOW_NOT_FOREGROUND');const before=f.actions.length;
  await backend.tick();await backend.tick();
  assert.equal(backend.stopped,false);assert.equal(backend.outbox.get(f.job.id).index,0);
  assert.deepEqual(f.actions.slice(before).map(action=>action.action),[]);
  await backend.shutdown();
});

test('Qt native guard compiles and offline tests touch no desktop or clipboard',{skip:process.platform!=='win32',timeout:30000},t=>{
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'qt-native-test-'));t.after(()=>{const resolved=fs.realpathSync(output);assert.equal(path.dirname(resolved).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.match(path.basename(resolved),/^qt-native-test-/);fs.rmSync(resolved,{recursive:true,force:true});});
  const root=path.resolve(import.meta.dirname,'..');const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/build-qt-actions.ps1'),'-SelfTest','-OutputDirectory',output],{cwd:root,encoding:'utf8',windowsHide:true,timeout:25000});
  assert.equal(result.status,0,result.stdout+result.stderr);const report=JSON.parse(result.stdout.split(/\r?\n/).find(line=>line.startsWith('{')));assert.equal(report.ok,true);assert.equal(report.uiAccessed,false);assert.equal(report.inputSent,false);assert.equal(report.clipboardAccessed,false);assert.ok(report.checks>=12);
});

function uiaMetadataFixtureFrame(frame,roles){
  const result=structuredClone(frame);delete result.pixelFormat;result.observationKind='uia-metadata-v1';result.pixelsRead=false;
  result.regions=result.regions.map((entry,index)=>({role:roles[index],rect:entry.rect,controlSha256:digest(JSON.stringify({role:roles[index],rect:entry.rect}))}));return result;
}
function uiaFastNavigationFixture(t,{snapshot,opening,opened,focused,policy='uia-controls-v1',allowBackgroundText=false}={}){
  const f=fixture(t,withObservedPopups,{navigationPolicy:policy,allowBackgroundText,verifyControls:async()=>({verified:true,proof:'uia-controls-v1'})}),request=f.driver.client.request;
  const clock={value:Date.now()},waits=[];f.driver.now=()=>clock.value;f.driver.wait=async ms=>{waits.push(ms);clock.value+=ms;};
  f.driver.client.request=async(action,input)=>{
    if(action==='captureUiaNavigation'){
      assert.deepEqual(input,{surface:'main',regions:[f.driver.config.layout.header],image:false});
      const at=f.actions.length,frame=uiaMetadataFixtureFrame(await request('capture',input),['header']);f.actions[at]={action,...input};
      Object.assign(frame,{inputSent:false,navigationOnly:true,baselinePixelStable:false});
      await snapshot?.(frame,f);return frame;
    }
    if(action==='openUiaSearch'){
      assert.equal(input.key,undefined);assert.equal(input.rect,undefined);assert.equal(input.popupTransition.id,'search');
      if(opening)await opening(input,f);
      const at=f.actions.length,result=await request('chord',{...input,key:'Control+F'});f.actions[at]={action,...input};
      const reported={...result,navigationOnly:true,openedSearch:true,baselinePixelStable:false};await opened?.(reported);return reported;
    }
    if(action==='focusUiaEditor'){
      assert.deepEqual(input.editorRect,f.driver.config.layout.editor);assert.equal(input.rect,undefined);assert.equal(input.key,undefined);
      const at=f.actions.length;let result;try{result=await request('click',{...input,rect:input.editorRect});}finally{f.actions[at]={action,...input};}
      const postFocusFrame=uiaMetadataFixtureFrame(await request('capture',{surface:'main',regions:[f.driver.config.layout.header,f.driver.config.layout.editor],image:false}),['header','editor']);f.actions.pop();
      postFocusFrame.uiaControlFrame=true;
      const reported={...result,editorFocused:true,editorFocusReused:false,pointerDelivery:uiaPointerFixture('editor-focus'),postFocusFrame};await focused?.(reported);return reported;
    }
    if(action==='captureUiaSearch'||action==='captureUiaControls'){
      const at=f.actions.length,result=await request('capture',action==='captureUiaSearch'?{...input,regions:[f.driver.config.layout.search],surface:'observed-search',surfaceId:'search'}:input);f.actions[at]={action,...input};
      const frame=uiaMetadataFixtureFrame(result,action==='captureUiaSearch'?['search']:['header','editor']);frame.uiaControlFrame=action==='captureUiaControls';return frame;
    }
    if(action==='paste'){
      const metadata=policy==='uia-controls-v1'&&f.driver.frame?.observationKind==='uia-metadata-v1';
      const result=await request(action,input);
      if(metadata&&result.postPasteFrame){result.postPasteFrame=uiaMetadataFixtureFrame(result.postPasteFrame,input.scope==='search'?['search']:['header','editor']);result.postPasteFrame.uiaControlFrame=input.scope==='editor';result.uiaConsumptionConfirmed=true;}
      return result;
    }
    return request(action,input);
  };
  return{...f,clock,waits,plan:{interactionPlan:{executionMode:'focus-handoff'}}};
}

function uiaFirstConfig(base){
  const next=structuredClone(base);next.layoutMode='uia-v1';next.focusActivationMode='uia-caption-v1';
  next.layout=Object.fromEntries(['width','height','dpi','search','header','editor','send'].map(key=>[key,structuredClone(base.layout[key])]));
  for(const key of ['selfSurface','profileSurface','selfCloseKey','profileCloseKey'])delete next[key];return next;
}
function uiaFirstNavigationFixture(t,{ready=()=>true,mutateProof,focused,snapshot}={}){
  const f=uiaFastNavigationFixture(t,{focused,snapshot}),checks=[],request=f.driver.client.request;
  f.driver.config=validateQtConfig(uiaFirstConfig(f.driver.config));f.driver.controlVerificationPolicy='input-boundaries-v1';
  f.driver.resolveTarget=async job=>({wechatId:job.target,alias:'target_A',ambiguous:false,uniqueSearchName:true,searchName:'唯一联系人'});
  f.driver.verifyControls=async options=>{
    checks.push(options);const proof={verified:true,proof:'uia-controls-v1',conversationFingerprint:fastConversationFingerprint()};
    if(options.operation==='navigation-ready'){
      const request=options.navigationReadiness,matched=await ready(checks.filter(c=>c.operation==='navigation-ready').length,options,f);
      proof.navigationReady={version:1,ready:matched,reason:matched?null:'UI_CONTROLS_CONVERSATION_TITLE_MISMATCH',primaryTitleSha256:matched?request.expectedTitleSha256:'5'.repeat(64),querySha256:request.expectedQuerySha256,samePage:true,pageRuntimeIdSha256:'6'.repeat(64),editorWritable:true,searchClosed:true,searchPopupHwnd:request.searchPopupHwnd,targetVerified:false};
    }
    await mutateProof?.(proof,options,f);return proof;
  };
  f.driver.client.request=async(action,input)=>{
    if(action==='focusUiaReadyEditor'){
      assert.equal(input.searchGeneration,'8'.repeat(32));assert.equal(input.uiaReady.proof,'uia-controls-v1');assert.equal(input.uiaReady.binding.pid,42);
      const at=f.actions.length,result=await request('focusUiaEditor',input);f.actions[at]={action,...input};return result;
    }
    const result=await request(action,input);if(action==='searchEnter')result.searchGeneration='8'.repeat(32);if(action==='transferFocusHandoff')result.cleanup.issuedAtMs=f.clock.value;
    if(action==='paste'&&input.scope==='editor'&&result.postPasteFrame)result.postPasteFrame.uiaControlFrame=true;
    return result;
  };
  return{...f,checks};
}

test('UIA cold host warms before account inspection and focus acquisition while continuation keeps fresh verification',async t=>{
  const f=uiaFirstNavigationFixture(t),request=f.driver.client.request,probe=f.driver.probeAccount,order=[];
  f.driver.client.request=async(action,input)=>{order.push(action);return request(action,input);};f.driver.probeAccount=async input=>{order.push('account');return probe(input);};
  assert.equal((await f.driver.prepare(f.job,f.plan)).ready,true);assert.ok(order.indexOf('warmUiaLocators')<order.indexOf('account'));assert.ok(order.indexOf('account')<order.indexOf('beginFocusHandoff'));assert.equal(f.actions.filter(a=>a.action==='warmUiaLocators').length,1);
  let observed=await f.driver.observe(f.job);await f.driver.pasteText(f.job,{expectedDraft:'',text:f.job.text,editorToken:observed.editorToken,activityRevision:observed.activityRevision},{canInput:()=>true});observed=await f.driver.observe(f.job);await f.driver.submit(f.job,{expectedDraft:f.job.text,editorToken:observed.editorToken,activityRevision:observed.activityRevision},{canSubmit:()=>true});
  f.setDraft('');const next={...f.job,id:'6'.repeat(64),text:'下一条'};assert.equal((await f.driver.prepare(next,f.plan)).ready,true);assert.equal(f.actions.filter(a=>a.action==='warmUiaLocators').length,1);assert.equal(f.actions.filter(a=>a.action==='captureUiaNavigation').length,2);assert.ok(f.checks.some(c=>c.operation==='navigation-continuation'));
  await f.driver.releaseTextFocus();
});

test('UIA warmup memo is local to the selected host and exact window identity and geometry, never a frame',async t=>{
  const f=uiaFirstNavigationFixture(t),original=f.driver.client,request=original.request;let shift=0,pid=42;
  original.request=async(action,input)=>{const result=await request(action,input);if(action==='inspectLayout'){result.binding.pid=pid;result.binding.captureRect.left+=shift;result.binding.captureRect.right+=shift;}return result;};
  await f.driver.warmUiaLocators();await f.driver.warmUiaLocators();assert.equal(f.actions.filter(a=>a.action==='warmUiaLocators').length,1);assert.equal(f.driver.frame,null);assert.equal(f.driver.transaction,null);assert.equal(f.driver.current,null);
  shift=1;await f.driver.warmUiaLocators();pid=43;await f.driver.warmUiaLocators();assert.equal(f.actions.filter(a=>a.action==='warmUiaLocators').length,3);
  f.driver.client={...original,request:(...args)=>original.request(...args)};await f.driver.warmUiaLocators();assert.equal(f.actions.filter(a=>a.action==='warmUiaLocators').length,4);assert.equal(f.driver.frame,null);
  assert.equal(f.actions.some(a=>['beginFocusHandoff','click','paste','submitTextEnter'].includes(a.action)),false);
});

test('failed or malformed UIA warmup stops before focus or input and never memoizes readiness',async t=>{
  for(const kind of ['native','authorization','input','focus','tick','cursor','binding','roles','token','cancel']){
    const f=uiaFirstNavigationFixture(t),request=f.driver.client.request,abort=new AbortController();
    f.driver.client.request=async(action,input)=>{const result=await request(action,input);if(action==='warmUiaLocators'){
      if(kind==='native')throw Object.assign(Error('provider unavailable'),{code:'QT_UIA_CONTROL_UNAVAILABLE',attempted:false});if(kind==='authorization')result.authorizationGranted=true;if(kind==='input')result.inputSent=true;if(kind==='focus')result.foregroundUnchanged=false;if(kind==='tick')result.inputTickUnchanged=false;if(kind==='cursor')result.cursorUnchanged=false;if(kind==='binding')result.binding.pid++;if(kind==='roles')result.roles.reverse();if(kind==='token')result.token='a'.repeat(32);if(kind==='cancel')abort.abort();
    }return result;};
    await assert.rejects(f.driver.prepare(f.job,{...f.plan,signal:abort.signal}));assert.equal(f.driver.uiaWarmHint,undefined,kind);assert.equal(f.actions.some(a=>['beginFocusHandoff','click','chord','paste','type','submitTextEnter'].includes(a.action)),false,kind);
  }
});

test('UIA voice warms its final host before its own focus acquisition without adding OCR warmup',async t=>{
  const f=uiaFirstNavigationFixture(t),calibration=adaptiveVoiceCalibration();f.driver.config.voice={recordStartRect:calibration.recordStartRect,toolbarRect:calibration.recordingUi.adaptive.toolbarRect,recordingUi:{focusHwnd:'same',uia:{version:1,executableVersion:'4.1.15.56'}}};
  const prepared=await f.driver.prepareVoiceSession(f.job,f.plan);const warm=f.actions.findIndex(a=>a.action==='warmUiaLocators'),begin=f.actions.findIndex(a=>a.action==='beginFocusHandoff');assert.ok(warm>=0&&warm<begin);assert.equal(f.actions.filter(a=>a.action==='warmUiaLocators').length,1);await prepared.releaseFocus();
  const ocr=fixture(t,withObservedPopups);await ocr.driver.prepare(ocr.job,{interactionPlan:{executionMode:'focus-handoff'}});assert.equal(ocr.actions.some(a=>a.action==='warmUiaLocators'),false);await ocr.driver.releaseTextFocus();
});

test('uia-v1 accepts four live regions without pixel templates and requires the native-caption policy',()=>{
  const base=uiaFirstConfig(withObservedPopups(config()));assert.deepEqual(validateQtConfig(base),base);
  for(const mutate of [c=>delete c.focusActivationMode,c=>c.focusActivationMode='blank-caption-v1',c=>c.layout.emptyEditorSha256='c'.repeat(64),c=>c.layout.selfOpen=r(1,1,10,10),c=>c.selfSurface={},c=>c.profileSurface={},c=>c.focusActivation={rect:r(400,2,440,14),rgbaSha256:'a'.repeat(64)},c=>c.selfCloseKey='Escape',c=>c.profileCloseKey='Escape']){
    const changed=structuredClone(base);mutate(changed);assert.throws(()=>validateQtConfig(changed));
  }
  const client={request:async()=>({})};for(const options of [{},{navigationPolicy:'uia-controls-v1'},{controlVerificationPolicy:'input-boundaries-v1'}])assert.throws(()=>new QtVisualDriver({root:os.tmpdir(),config:base,client,verifyControls:async()=>({}),...options}),{code:'UI_QT_CONTROLS_POLICY_INVALID'});
});

test('UIA unique display names come from each fresh account-bound target lookup and nonunique names retain alias search',async t=>{
  const f=uiaFirstNavigationFixture(t);let lookups=0,name='唯一联系人';f.driver.resolveTarget=async job=>{lookups++;return{wechatId:job.target,alias:'target_A',ambiguous:false,uniqueSearchName:true,searchName:name};};
  for(const value of ['唯一联系人','新昵称']){name=value;const lookup=await f.driver.lookupTarget(f.job);assert.equal(lookup.displayedId,value);assert.equal(lookup.searchKind,'private-name');assert.deepEqual(lookup.uiaTarget,{version:1,proof:'database-unique-display-name-v1',titleSha256:digest(value),querySha256:digest(value)});assert.equal(Object.isFrozen(lookup.uiaTarget),true);}
  assert.equal(lookups,2);f.driver.resolveTarget=async job=>({wechatId:job.target,alias:'target_A',name:'同名联系人',ambiguous:false,uniqueSearchName:false,searchName:''});
  const alias=await f.driver.lookupTarget(f.job);assert.equal(alias.displayedId,'target_A');assert.deepEqual(alias.uiaTarget,{version:1,proof:'database-exact-alias-v1',titleSha256:digest('同名联系人'),querySha256:digest('target_A')});
  f.driver.resolveTarget=async job=>({wechatId:job.target,ambiguous:false,kind:'group',uniqueSearchName:true,name:'唯一群名',groupName:'唯一群名'});
  const group=await f.driver.lookupTarget({...f.job,target:'123@chatroom'});assert.equal(group.searchKind,'group-title');assert.equal(group.uiaTarget.titleSha256,digest('唯一群名'));
});

test('fresh current UIA conversation readiness focuses once without opening search or waiting for pixels',async t=>{
  const f=uiaFirstNavigationFixture(t);f.driver.waitForSearchEnterTransition=()=>assert.fail('no pixel transition for UIA ready');f.driver.warmOcr=f.driver.recognize=()=>assert.fail('UIA ready must not OCR');
  assert.equal((await f.driver.prepare(f.job,f.plan)).ready,true);assert.deepEqual(f.waits,[]);assert.deepEqual(f.checks.map(c=>c.operation),['navigation-ready']);assert.equal(f.checks[0].navigationReadiness.searchPopupHwnd,'0');
  assert.equal(f.actions.filter(a=>a.action==='focusUiaEditor').length,1);assert.equal(f.actions.some(a=>['openUiaSearch','searchEnter','paste','chord','type','readDraft'].includes(a.action)),false);
  assert.deepEqual(f.driver.current.uiaConversationFingerprint,fastConversationFingerprint());assert.equal(f.driver.current.privateChatProof.kind,'uia-database-title-v1');
  const begin=f.actions.find(a=>a.action==='beginFocusHandoff');assert.equal(begin.uiaCaptionActivation,true);assert.equal(begin.focusActivation,undefined);await f.driver.releaseTextFocus();
});

test('UIA search navigation polls semantic readiness then consumes its exact native search generation',async t=>{
  const f=uiaFirstNavigationFixture(t,{ready:count=>count>=4});f.driver.waitForSearchEnterTransition=()=>assert.fail('UIA semantic transition must not use 350 ms pixel grace');
  assert.equal((await f.driver.prepare(f.job,f.plan)).ready,true);assert.deepEqual(f.waits,[10,10]);assert.equal(f.actions.filter(a=>a.action==='searchEnter').length,1);assert.equal(f.actions.filter(a=>a.action==='openUiaSearch').length,1);assert.equal(f.actions.filter(a=>a.action==='focusUiaReadyEditor').length,1);assert.equal(f.actions.some(a=>a.action==='focusUiaEditor'),false);
  assert.deepEqual(f.checks.filter(c=>c.operation==='navigation-ready').map(c=>c.navigationReadiness.searchPopupHwnd),['0','400','400','400']);assert.deepEqual(f.driver.current.uiaConversationFingerprint,fastConversationFingerprint());await f.driver.releaseTextFocus();
});

function navigationLayoutCandidate(options,driver,bottom=120){
  return{version:1,binding:Object.fromEntries(['hwnd','pid','threadId','processCreatedFileTimeUtc','dpi','clientRect','captureRect'].map(key=>[key,structuredClone(options.binding[key])])),layout:{...structuredClone(driver.config.layout),header:{...driver.config.layout.header,bottom}},voice:{recordStartRect:structuredClone(driver.config.voice.recordStartRect),toolbarRect:structuredClone(driver.config.voice.recordingUi.adaptive.toolbarRect)}};
}
test('UIA popup polling uses 10 ms reads through the full deadline and never repeats navigation input',async t=>{
  const f=uiaFirstNavigationFixture(t,{ready:count=>count>1}),request=f.driver.client.request;let began,reads=0;
  f.driver.client.request=async(action,input)=>{
    if(action==='captureUiaSearch'){
      began??=f.clock.value;reads++;
      if(f.clock.value-began<590)throw Object.assign(Error('popup pending'),{code:'QT_POPUP_CANDIDATE_NOT_UNIQUE',attempted:false});
    }
    return request(action,input);
  };
  assert.equal((await f.driver.prepare(f.job,f.plan)).ready,true);assert.equal(reads,60);assert.equal(f.clock.value-began,590);assert.ok(f.waits.every(ms=>ms===10));
  assert.equal(f.actions.filter(a=>a.action==='openUiaSearch').length,1);assert.equal(f.actions.filter(a=>a.action==='paste'&&a.scope==='search').length,1);assert.equal(f.actions.filter(a=>a.action==='searchEnter').length,1);await f.driver.releaseTextFocus();
});
test('UIA semantic readiness retains 600 ms budget with fast polling and stops after slow expired reads',async t=>{
  for(const slow of [false,true]){
    let began,reads=0;const f=uiaFirstNavigationFixture(t,{ready:(_count,options,current)=>{
      if(options.navigationReadiness.searchPopupHwnd==='0')return false;
      began??=current.clock.value;reads++;
      if(slow){current.clock.value+=601;return true;}
      return current.clock.value-began>=590;
    }});
    if(slow)await assert.rejects(f.driver.prepare(f.job,f.plan),{code:'UI_QT_SEARCH_TRANSITION_UNCONFIRMED'});
    else assert.equal((await f.driver.prepare(f.job,f.plan)).ready,true);
    assert.equal(reads,slow?1:60);assert.ok(f.waits.every(ms=>ms===10));
    assert.equal(f.actions.filter(a=>a.action==='openUiaSearch').length,1);assert.equal(f.actions.filter(a=>a.action==='searchEnter').length,1);
    assert.equal(f.actions.filter(a=>a.action==='focusUiaReadyEditor').length,slow?0:1);assert.equal(f.actions.some(a=>a.action==='submitTextEnter'),false);await f.driver.releaseTextFocus();
  }
});
function offscreenSearchPopupFixture(frame,{left=508,top=-22,width=400,height=120}={}){
  const b=frame.binding;Object.assign(frame.popup,{offscreenSearch:true,ownerRelation:'root-owned',clientRect:r(0,0,width,height),clientRectInRoot:r(left,top,left+width,top+height),windowRect:r(b.captureRect.left+left,b.captureRect.top+top,b.captureRect.left+left+width,b.captureRect.top+top+height)});return frame;
}
test('native-marked UIA offscreen search follows Qt popup position and height while input stays in the live root query',async t=>{
  const f=uiaFirstNavigationFixture(t,{ready:count=>count>1}),request=f.driver.client.request;f.driver.config.searchPopupCalibration.ownerRelation='root-owned';f.driver.config.searchPopupCalibration.ownerDepth=1;
  f.driver.client.request=async(action,input)=>{const result=await request(action,input);if(action==='captureUiaSearch')offscreenSearchPopupFixture(result);if(action==='paste'&&input.scope==='search')offscreenSearchPopupFixture(result.postPasteFrame,{left:480,top:-40,height:300});return result;};
  assert.equal((await f.driver.prepare(f.job,f.plan)).ready,true);assert.equal(f.actions.filter(a=>a.action==='openUiaSearch').length,1);assert.equal(f.actions.filter(a=>a.action==='paste'&&a.scope==='search').length,1);assert.equal(f.actions.filter(a=>a.action==='searchEnter').length,1);await f.driver.releaseTextFocus();
});
test('offscreen search geometry requires native markers on both UIA frames and preserves identity width margins and query bounds',async t=>{
  for(const change of ['missing-before','missing-after','false-marker','width','margin','hwnd','owner','query']){
    const f=uiaFirstNavigationFixture(t,{ready:count=>count>1}),request=f.driver.client.request;f.driver.config.searchPopupCalibration.ownerRelation='root-owned';f.driver.config.searchPopupCalibration.ownerDepth=1;
    f.driver.client.request=async(action,input)=>{const result=await request(action,input);
      if(action==='captureUiaSearch'){offscreenSearchPopupFixture(result);if(change==='missing-before')delete result.popup.offscreenSearch;}
      if(action==='paste'&&input.scope==='search'){
        const next=offscreenSearchPopupFixture(result.postPasteFrame,{left:480,top:-40,height:300});
        if(change==='missing-after')delete next.popup.offscreenSearch;if(change==='false-marker')next.popup.offscreenSearch=false;
        if(change==='width')offscreenSearchPopupFixture(next,{width:401});if(change==='margin')next.popup.windowRect.top--;
        if(change==='hwnd')next.popup.hwnd='999';if(change==='owner')next.popup.ownerRelation='same-thread-unowned';if(change==='query')next.regions[0].rect=r(0,0,801,20);
      }
      return result;
    };
    await assert.rejects(f.driver.prepare(f.job,f.plan),{code:change==='missing-before'?'UI_QT_POPUP_BINDING_INVALID':'UI_QT_PASTE_UNVERIFIED'});assert.equal(f.actions.some(a=>a.action==='searchEnter'||a.action==='submitTextEnter'),false);await f.driver.releaseTextFocus();
  }
});
test('confirmed UIA search alone can adopt a fresh expanded or contracted group header in the same native lease',async t=>{
  for(const bottom of [120,40]){
    let lease;const f=uiaFirstNavigationFixture(t,{ready:count=>count>=2,mutateProof:(proof,options,current)=>{
      if(options.operation==='navigation-ready'&&options.navigationReadiness.searchPopupHwnd!=='0'){
        assert.equal(options.allowLayoutRefresh,true);lease=current.driver.preparationLease();proof.navigationLayout=navigationLayoutCandidate(options,current.driver,bottom);
      }else assert.equal(options.allowLayoutRefresh,undefined);
    }});f.driver.config.voice=adaptiveVoiceCalibration();const original=f.driver.config,owner=f.driver.client;
    assert.equal((await f.driver.prepare(f.job,f.plan)).ready,true);assert.equal(f.driver.config.layout.header.bottom,bottom);assert.equal(original.layout.header.bottom,60);assert.equal(f.driver.client,owner);assert.equal(f.driver.preparationLease(),lease);
    const focus=f.actions.find(a=>a.action==='focusUiaReadyEditor');assert.equal(focus.headerRect.bottom,bottom);assert.equal(focus.searchGeneration,'8'.repeat(32));assert.deepEqual(f.driver.frame.regions[0].rect,focus.headerRect);assert.equal(f.actions.filter(a=>a.action==='searchEnter').length,1);
    const observed=await f.driver.observe(f.job);assert.equal((await f.driver.pasteText(f.job,{expectedDraft:'',text:f.job.text,editorToken:observed.editorToken,activityRevision:observed.activityRevision},{canInput:()=>true})).performed,true);assert.equal(f.checks.at(-1).operation,'text-input');assert.equal(f.checks.at(-1).config.layout.header.bottom,bottom);await f.driver.releaseTextFocus();
  }
});

test('UIA layout adoption rejects changed authority, geometry or unsanitized role candidates before editor focus',async t=>{
  for(const kind of ['version','extra','pid','thread','capture','dimensions','header','voice','voice-extra','old-template','activity','lease','title','fingerprint']){
    const f=uiaFirstNavigationFixture(t,{ready:count=>count>=2,mutateProof:(proof,options,current)=>{
      if(options.operation!=='navigation-ready'||options.navigationReadiness.searchPopupHwnd==='0')return;
      const candidate=proof.navigationLayout=navigationLayoutCandidate(options,current.driver);
      if(kind==='version')candidate.version=2;if(kind==='extra')candidate.authorized=true;if(kind==='pid')candidate.binding.pid++;if(kind==='thread')candidate.binding.threadId++;if(kind==='capture')candidate.binding.captureRect.left++;
      if(kind==='dimensions')candidate.layout.height++;if(kind==='header')candidate.layout.header.right=900;if(kind==='voice')candidate.voice.toolbarRect.bottom=900;if(kind==='voice-extra')candidate.voice.submitRect=r(1,1,10,10);if(kind==='old-template')candidate.layout.emptyEditorSha256='c'.repeat(64);
      if(kind==='activity')current.driver.transaction.revision++;if(kind==='lease')current.driver.textFocusLease={...current.driver.textFocusLease};if(kind==='title')proof.navigationReady.primaryTitleSha256='9'.repeat(64);if(kind==='fingerprint')delete proof.conversationFingerprint;
    }});f.driver.config.voice=adaptiveVoiceCalibration();let result;try{result=await f.driver.prepare(f.job,f.plan);}catch(error){result={ready:false,reason:error.code};}
    assert.equal(result.ready,false,kind);assert.equal(f.actions.some(a=>a.action==='focusUiaReadyEditor'||a.action==='paste'&&a.scope==='editor'||a.action==='submitTextEnter'),false,kind);assert.equal(f.driver.config.layout.header.bottom,60,kind);assert.equal(f.driver.textFocusLease,null,kind);
  }
});

test('a negative UIA readiness observation cannot adopt its layout proposal',async t=>{
  const f=uiaFirstNavigationFixture(t,{ready:count=>count>=3,mutateProof:(proof,options,current)=>{
    if(options.operation==='navigation-ready'&&proof.navigationReady.ready===false&&options.navigationReadiness.searchPopupHwnd!=='0')proof.navigationLayout=navigationLayoutCandidate(options,current.driver);
  }});f.driver.config.voice=adaptiveVoiceCalibration();assert.equal((await f.driver.prepare(f.job,f.plan)).ready,true);assert.equal(f.driver.config.layout.header.bottom,60);assert.deepEqual(f.waits,[10]);assert.equal(f.actions.find(a=>a.action==='focusUiaReadyEditor').headerRect.bottom,60);await f.driver.releaseTextFocus();
});

test('UIA native refusal diagnostics survive the read-only control wrapper without native text',async t=>{
  const f=uiaFirstNavigationFixture(t,{mutateProof:(_proof,options)=>{if(options.operation==='navigation-ready')throw Object.assign(Error('PRIVATE_NATIVE_TEXT'),{code:'UIA_MODE_RESULT_UNCONFIRMED',nativeReason:'UI_CONTROLS_LAYOUT_MOVED'});}});
  await assert.rejects(f.driver.prepare(f.job,f.plan),error=>error.code==='UIA_MODE_RESULT_UNCONFIRMED'&&error.nativeReason==='UI_CONTROLS_LAYOUT_MOVED'&&!error.message.includes('PRIVATE_NATIVE_TEXT'));assert.equal(f.driver.textFocusLease,null);
});

test('UIA readiness never permits body input on malformed target evidence or absent fingerprint',async t=>{
  for(const kind of ['version','ready-type','query','title','popup','page','writable','search','fingerprint','provider-failed']){
    const f=uiaFirstNavigationFixture(t,{mutateProof:(proof,options)=>{if(options.operation!=='navigation-ready')return;const ready=proof.navigationReady;
      if(kind==='version')ready.version=2;if(kind==='ready-type')ready.ready='true';if(kind==='query')ready.querySha256='7'.repeat(64);if(kind==='title')ready.primaryTitleSha256='7'.repeat(64);if(kind==='popup')ready.searchPopupHwnd='101';if(kind==='page')ready.samePage=false;if(kind==='writable')ready.editorWritable=false;if(kind==='search')ready.searchClosed=false;if(kind==='fingerprint')delete proof.conversationFingerprint;if(kind==='provider-failed')throw Object.assign(Error('failed'),{code:'UIA_MODE_READINESS_INVALID'});
    }});let result;try{result=await f.driver.prepare(f.job,f.plan);}catch(error){result={ready:false,reason:error.code};}
    assert.equal(result.ready,false,kind);assert.equal(f.actions.some(a=>['focusUiaEditor','focusUiaReadyEditor','openUiaSearch','searchEnter','paste','submitTextEnter'].includes(a.action)),false,kind);assert.equal(f.driver.textFocusLease,null,kind);
  }
});

test('UIA search readiness stops on cancellation, native activity or changed focus binding without retrying search',async t=>{
  for(const kind of ['cancel','activity','pid','geometry','revision','marker','generation','timeout']){
    const abort=new AbortController(),f=uiaFirstNavigationFixture(t,{ready:count=>kind==='timeout'?false:count>=2,mutateProof:(_proof,options)=>{if(options.operation==='navigation-ready'&&options.navigationReadiness.searchPopupHwnd!=='0'){if(kind==='cancel')abort.abort();if(kind==='activity')throw Object.assign(Error('activity'),{code:'UIA_MODE_BINDING_CHANGED'});}},focused:result=>{if(kind==='pid')result.postFocusFrame.binding.pid++;if(kind==='geometry')result.postFocusFrame.binding.captureRect.left++;if(kind==='revision')result.postFocusFrame.revision++;if(kind==='marker')delete result.postFocusFrame.uiaControlFrame;}});
    if(kind==='generation'){const request=f.driver.client.request;f.driver.client.request=async(action,values)=>{const result=await request(action,values);if(action==='searchEnter')delete result.searchGeneration;return result;};}
    f.driver.waitForSearchEnterTransition=()=>assert.fail('never fall back to pixel success after a readiness refusal');let result;try{result=await f.driver.prepare(f.job,{...f.plan,signal:abort.signal});}catch(error){result={ready:false,reason:error.code};}
    assert.equal(result.ready,false,kind);assert.equal(f.actions.filter(a=>a.action==='searchEnter').length,1,kind);assert.equal(f.actions.filter(a=>a.action==='openUiaSearch').length,1,kind);assert.equal(f.actions.some(a=>a.action==='paste'&&a.scope==='editor'||a.action==='submitTextEnter'),false,kind);assert.equal(f.driver.textFocusLease,null,kind);assert.ok(f.waits.reduce((a,b)=>a+b,0)<=600,kind);
  }
});

test('nonunique display names require exact alias search and semantic readiness without the current-chat shortcut or pixel waits',async t=>{
  const f=uiaFirstNavigationFixture(t);f.driver.resolveTarget=async job=>({wechatId:job.target,alias:'target_A',name:'同名联系人',ambiguous:false,uniqueSearchName:false,searchName:''});
  f.driver.waitForSearchEnterTransition=async()=>{throw Error('UIA alias must not use pixel transition');};
  assert.equal((await f.driver.prepare(f.job,f.plan)).ready,true);
  const checks=f.checks.filter(c=>c.operation==='navigation-ready');assert.equal(checks.length,1);assert.equal(checks[0].navigationReadiness.expectedTitleSha256,digest('同名联系人'));assert.equal(checks[0].navigationReadiness.expectedQuerySha256,digest('target_A'));assert.notEqual(checks[0].navigationReadiness.searchPopupHwnd,'0');
  assert.equal(f.actions.filter(a=>a.action==='searchEnter').length,1);assert.equal(f.actions.filter(a=>a.action==='focusUiaReadyEditor').length,1);assert.equal(f.actions.some(a=>a.action==='focusUiaEditor'),false);assert.equal(f.actions.find(a=>a.action==='paste'&&a.scope==='search').text,'target_A');assert.deepEqual(f.waits,[]);await f.driver.releaseTextFocus();
});

test('UIA search uses fresh native field geometry after Ctrl+F and query paste without rewriting the main-window layout',async t=>{
  const f=uiaFirstNavigationFixture(t,{ready:count=>count>1}),original=structuredClone(f.driver.config.layout.search),observed={...original,left:original.left+8,right:original.right-12},afterPaste={...observed,right:observed.right-6},request=f.driver.client.request;
  f.driver.client.request=async(action,input)=>{
    if(action==='paste'&&input.scope==='search')assert.deepEqual(f.driver.region('search'),observed);
    const result=await request(action,input);
    if(action==='captureUiaSearch')result.regions[0].rect=structuredClone(observed);
    if(action==='paste'&&input.scope==='search')result.postPasteFrame.regions[0].rect=structuredClone(afterPaste);
    return result;
  };
  assert.equal((await f.driver.prepare(f.job,f.plan)).ready,true);
  assert.deepEqual(f.driver.config.layout.search,original);assert.deepEqual(f.driver.region('search'),original);
  assert.equal(f.actions.filter(a=>a.action==='searchEnter').length,1);assert.equal(f.actions.filter(a=>a.action==='captureUiaSearch').length,1);
  await f.driver.releaseTextFocus();
});

test('UIA search rejects non-search or out-of-window native regions before publishing the query',async t=>{
  for(const kind of ['wrong-role','outside']){
    const f=uiaFirstNavigationFixture(t,{ready:count=>count>1}),request=f.driver.client.request;
    f.driver.client.request=async(action,input)=>{const result=await request(action,input);if(action==='captureUiaSearch'){if(kind==='wrong-role')result.regions[0].role='editor';else result.regions[0].rect.right=f.driver.config.layout.width+1;}return result;};
    await assert.rejects(f.driver.prepare(f.job,f.plan),{code:'UI_QT_POPUP_BINDING_INVALID'});
    assert.equal(f.actions.some(a=>a.action==='paste'||a.action==='searchEnter'),false);assert.equal(f.driver.textFocusLease,null);
  }
});

test('UIA first text path retains fresh semantic verification through body paste and one submission without empty templates',async t=>{
  const f=uiaFirstNavigationFixture(t);assert.equal((await f.driver.prepare(f.job,f.plan)).ready,true);let observed=await f.driver.observe(f.job);
  assert.equal((await f.driver.pasteText(f.job,{expectedDraft:'',text:f.job.text,editorToken:observed.editorToken,activityRevision:observed.activityRevision},{canInput:()=>true})).performed,true);
  observed=await f.driver.observe(f.job);assert.equal((await f.driver.submit(f.job,{expectedDraft:f.job.text,editorToken:observed.editorToken,activityRevision:observed.activityRevision},{canSubmit:()=>true})).performed,true);
  assert.deepEqual(f.checks.map(c=>c.operation),['navigation-ready','text-input','text-submit']);assert.equal(f.actions.filter(a=>a.action==='submitTextEnter').length,1);assert.equal(f.actions.some(a=>a.action==='readDraft'),false);assert.equal(f.driver.config.layout.emptyEditorSha256,undefined);assert.equal(f.driver.textFocusLease,null);
});

function uiaPointerFixture(scope){return{version:1,method:'window-message-v1',scope,messagesPosted:3,queueAccepted:true,systemCursorMovementRequested:false,cursorUnchanged:true,completion:scope==='editor-focus'?'uia-focus':'receipt-pending'};}

test('UIA editor focus can reuse actual keyboard focus without dispatching another click',async t=>{
  for(const cold of [false,true]){
    const f=uiaFirstNavigationFixture(t,{ready:count=>!cold||count>1,focused:result=>Object.assign(result,{attempted:false,inputSent:false,editorFocusReused:true,pointerDelivery:null})});
    assert.equal((await f.driver.prepare(f.job,f.plan)).ready,true);await f.driver.releaseTextFocus();
  }
});

test('UIA editor focus refuses incomplete reuse or malformed directed input evidence',async t=>{
  for(const kind of ['input','marker','scope','queue','count','cursor','completion']){
    const f=uiaFirstNavigationFixture(t,{focused:result=>{
      if(kind==='input'||kind==='marker')Object.assign(result,{attempted:false,inputSent:kind==='input',editorFocusReused:kind!=='marker',pointerDelivery:null});
      else{const p=result.pointerDelivery;if(kind==='scope')p.scope='image-submit';if(kind==='queue')p.queueAccepted=false;if(kind==='count')p.messagesPosted=2;if(kind==='cursor')p.cursorUnchanged=false;if(kind==='completion')p.completion='receipt-pending';}
    }});
    await assert.rejects(f.driver.prepare(f.job,f.plan),undefined,kind);
    assert.equal(f.actions.some(a=>a.action==='paste'||a.action==='submitTextEnter'),false,kind);
  }
});

async function uiaImageFixture(t,{format='static',...options}={}){
  const f=uiaFirstNavigationFixture(t,options);f.job.image={path:path.join(f.driver.root,format==='gif'?'fixture.gif':'fixture.png'),sha256:'a'.repeat(64),...(format==='gif'?{format}:{})};
  assert.equal((await f.driver.prepare(f.job,f.plan)).ready,true);
  const request=f.driver.client.request,state={proof:null,frame:null,paused:false,consumed:false,revision:f.driver.current.revision};
  f.driver.client.request=async(action,input)=>{
    if(action==='pasteUiaImage'){
      f.actions.push({action,...input});assert.equal(input.token,f.driver.frame.token);assert.equal(input.imageSha256,f.job.image.sha256);assert.deepEqual(input.sendRect,f.driver.config.layout.send);
      const frame=structuredClone(f.driver.frame);frame.token='6'.repeat(32);frame.regions.push({role:'send',rect:structuredClone(f.driver.config.layout.send),controlSha256:'5'.repeat(64)});
      state.proof={version:1,id:'9'.repeat(32),imageSha256:input.imageSha256,imageFormat:format};state.frame=frame;
      return{performed:true,attempted:true,pasteApplied:true,clipboardRestored:true,revision:state.revision,imageFormat:format,originalFilePasted:format==='gif',readbackPerformed:false,messageSent:false,imagePasteProof:structuredClone(state.proof),postPasteFrame:structuredClone(frame)};
    }
    if(action==='submitUiaImage'){
      f.actions.push({action,...input});assert.equal(state.consumed,false);assert.equal(input.imagePasteProofId,state.proof.id);assert.equal(input.imageSha256,state.proof.imageSha256);assert.equal(input.rect,undefined);assert.equal(input.uiaControlFrame,undefined);state.consumed=true;
      return{performed:true,attempted:true,submitted:false,inputQueued:true,submissionConfirmed:false,pointerDelivery:uiaPointerFixture('image-submit'),revision:state.revision};
    }
    if(action==='resumeUiaImage'){
      f.actions.push({action,...input});assert.equal(state.paused,true);assert.equal(input.imagePasteProofId,state.proof.id);assert.equal(input.imageSha256,state.proof.imageSha256);
      if(input.revision!==state.revision||state.consumed)throw Object.assign(Error('invalid proof'),{code:'QT_UIA_IMAGE_PROOF_INVALID',attempted:false});
      state.paused=false;state.frame.token='7'.repeat(32);return{resumed:true,readOnly:true,inputSent:false,focusChanged:false,clipboardAccessed:false,imagePasteProof:structuredClone(state.proof),frame:structuredClone(state.frame)};
    }
    const result=await request(action,input);if(action==='releaseFocusHandoff'&&state.proof)state.paused=true;return result;
  };
  f.actions.length=0;f.checks.length=0;return{...f,imageState:state};
}

test('a verified file confirmation uses its own scoped submit proof and never the image button',async t=>{
  const f=await uiaImageFixture(t);
  f.job.mode='file';f.job.image={...f.job.image,path:path.join(f.driver.root,'报告.pdf'),format:'file'};
  const original=f.driver.client.request,proof={id:'a'.repeat(32),sha256:f.job.image.sha256},actions=[];
  f.driver.client.request=async(action,req)=>{
    actions.push(action);
    if(action==='pasteUiaFile'){
      assert.equal(req.deliveryId,f.job.id);assert.match(req.titleSha256,/^[a-f0-9]{64}$/);
      return{performed:true,attempted:true,pasteApplied:true,clipboardRestored:true,revision:f.driver.current.revision,
        originalFilePasted:true,imageConsumption:{format:15,consumerProcessMatched:true},fileDialogProof:proof};
    }
    if(action==='submitUiaFileDialog'){
      assert.deepEqual(req,{proofId:proof.id,sha256:proof.sha256});
      return{performed:true,attempted:true,inputQueued:true,revision:f.driver.current.revision};
    }
    return original(action,req);
  };
  const before=await f.driver.observe(f.job);
  assert.equal((await f.driver.pasteImage(f.job,before,{canInput:()=>true})).performed,true);
  assert.equal((await f.driver.submitImage(f.job,await f.driver.observe(f.job),{canSubmit:()=>true})).performed,true);
  assert.deepEqual(actions,['pasteUiaFile','submitUiaFileDialog','releaseFocusHandoff']);
});
test('UIA image path uses only two fresh conversation boundaries and native one-use actions without screenshots',async t=>{
  const f=await uiaImageFixture(t);const before=await f.driver.observe(f.job);
  assert.equal((await f.driver.pasteImage(f.job,before,{canInput:()=>true})).imageApplied,true);
  const count=f.actions.length,checked=f.checks.length;
  for(let i=0;i<3;i++)assert.equal((await f.driver.observe(f.job)).appliedImageId,f.job.id);
  assert.equal(f.actions.length,count);assert.equal(f.checks.length,checked);
  assert.equal((await f.driver.submitImage(f.job,await f.driver.observe(f.job),{canSubmit:()=>true})).performed,true);
  assert.deepEqual(f.checks.map(c=>c.operation),['image-input','image-submit']);
  assert.deepEqual(f.actions.map(a=>a.action),['pasteUiaImage','submitUiaImage','releaseFocusHandoff']);
  assert.equal(f.driver.textFocusLease,null);
});

test('UIA static and GIF images retain original-format proof without pretending attachment load or readback',async t=>{
  for(const format of ['static','gif']){
    const f=await uiaImageFixture(t,{format});const result=await f.driver.pasteImage(f.job,await f.driver.observe(f.job),{canInput:()=>true});
    assert.equal(result.readbackPerformed,false);assert.equal(result.attachmentLoaded,undefined);assert.equal(f.driver.current.uiaImageProof.imageFormat,format);
    assert.equal(f.driver.frame.pixelsRead,false);assert.equal(f.driver.frame.pixelFormat,undefined);assert.ok(f.driver.frame.regions.every(r=>r.rgbaSha256===undefined&&r.controlSha256));
    assert.equal((await f.driver.submitImage(f.job,await f.driver.observe(f.job),{canSubmit:()=>true})).performed,true);
  }
});

test('UIA image paste reports authorized replacement and still requires its native attachment proof',async t=>{
  for(const withProof of [true,false]){
    const f=await uiaImageFixture(t,{format:'gif'}),request=f.driver.client.request;
    f.driver.allowClipboardReplacement=true;
    f.driver.client.request=async(action,input)=>{
      const result=await request(action,input);
      if(action==='pasteUiaImage'){
        assert.equal(input.allowClipboardReplacement,true);
        result.clipboardRestored=false;result.clipboardReplaced=true;
        if(!withProof)delete result.imagePasteProof;
      }
      return result;
    };
    const paste=f.driver.pasteImage(f.job,await f.driver.observe(f.job),{canInput:()=>true});
    if(withProof){
      const result=await paste;assert.equal(result.imageApplied,true);
      assert.equal(result.clipboardRestored,false);assert.equal(result.clipboardReplaced,true);
    }else await assert.rejects(paste,{code:'UI_QT_IMAGE_PASTE_UNCONFIRMED'});
    assert.equal(f.actions.some(a=>a.action==='submitUiaImage'),false);
  }
});

test('UIA image input never falls back to screenshots for missing metadata, semantic proof, policies or native lease',async t=>{
  for(const kind of ['marker','metadata','pixels','fingerprint','policy','verification-policy','lease','role','control-hash']){
    const f=await uiaImageFixture(t),guard=await f.driver.observe(f.job);
    if(kind==='marker')delete f.driver.frame.uiaControlFrame;if(kind==='metadata')delete f.driver.frame.observationKind;if(kind==='pixels')f.driver.frame.pixelFormat='rgba-row-major-opaque-v1';
    if(kind==='fingerprint')delete f.driver.current.uiaConversationFingerprint;if(kind==='policy')f.driver.navigationPolicy='pixels-v1';if(kind==='verification-policy')f.driver.controlVerificationPolicy=undefined;if(kind==='lease')f.driver.textFocusLease.parked=true;
    if(kind==='role')f.driver.frame.regions[0].role='editor';if(kind==='control-hash')delete f.driver.frame.regions[0].controlSha256;
    const result=await f.driver.pasteImage(f.job,guard,{canInput:()=>true});assert.equal(result.performed,false,kind);assert.equal(result.attempted,false,kind);assert.equal(f.actions.length,0,kind);await f.driver.releaseTextFocus();
  }
});

test('UIA image metadata cannot change window, native generation or region before body input',async t=>{
  for(const kind of ['pid','thread','created','hwnd','origin','epoch','revision','region','navigation','popup']){
    const f=await uiaImageFixture(t),guard=await f.driver.observe(f.job),frame=f.driver.frame;
    if(kind==='pid')frame.binding.pid++;if(kind==='thread')frame.binding.threadId++;if(kind==='created')frame.binding.processCreatedFileTimeUtc='888';if(kind==='hwnd')frame.binding.hwnd='101';if(kind==='origin')frame.binding.captureRect.left++;if(kind==='epoch')frame.epoch='7'.repeat(32);if(kind==='revision')frame.revision++;if(kind==='region')frame.regions[0].rect.left++;if(kind==='navigation')frame.navigationOnly=true;if(kind==='popup')frame.popup={};
    const result=await f.driver.pasteImage(f.job,guard,{canInput:()=>true});assert.equal(result.performed,false,kind);assert.equal(result.attempted,false,kind);assert.equal(f.actions.length,0,kind);await f.driver.releaseTextFocus();
  }
});

test('UIA image fresh input proof changes or uncertain clipboard input cannot cause a second paste',async t=>{
  for(const kind of ['semantic','frame-replaced','lease-replaced','native-refused','native-unknown']){
    const f=await uiaImageFixture(t),guard=await f.driver.observe(f.job),verify=f.driver.verifyControls,request=f.driver.client.request;let pastes=0;
    f.driver.verifyControls=async options=>{const proof=await verify(options);if(options.operation==='image-input'){if(kind==='semantic')proof.conversationFingerprint.sha256='f'.repeat(64);if(kind==='frame-replaced')f.driver.frame=structuredClone(f.driver.frame);if(kind==='lease-replaced')f.driver.textFocusLease={...f.driver.textFocusLease};}return proof;};
    f.driver.client.request=async(action,input)=>{if(action==='pasteUiaImage'){pastes++;throw Object.assign(Error('native'),{code:kind==='native-unknown'?'QT_INPUT_UNCERTAIN':'QT_UIA_IMAGE_SOURCE_REQUIRED',attempted:kind==='native-unknown',clipboardRestored:true});}return request(action,input);};
    if(kind==='native-unknown'){await assert.rejects(f.driver.pasteImage(f.job,guard,{canInput:()=>true}),{code:'QT_INPUT_UNCERTAIN',attempted:true});assert.equal(f.driver.current,null);assert.ok(f.driver.draftHold);assert.equal((await f.driver.pasteImage(f.job,guard,{canInput:()=>true})).performed,false);}
    else{const result=await f.driver.pasteImage(f.job,guard,{canInput:()=>true});assert.equal(result.performed,false,kind);assert.equal(result.attempted,false,kind);}
    assert.equal(pastes,kind.startsWith('native-')?1:0,kind);await f.driver.releaseTextFocus();
  }
});

test('UIA image malformed post-paste proofs preserve attempted input and an unknown draft',async t=>{
  for(const kind of ['proof-missing','proof-digest','proof-format','proof-id','proof-extra','clipboard','frame-missing','marker','pid','thread','revision','send-region','pixel-hash']){
    const f=await uiaImageFixture(t),guard=await f.driver.observe(f.job),request=f.driver.client.request;
    f.driver.client.request=async(action,input)=>{const result=await request(action,input);if(action==='pasteUiaImage'){
      if(kind==='proof-missing')delete result.imagePasteProof;if(kind==='proof-digest')result.imagePasteProof.imageSha256='f'.repeat(64);if(kind==='proof-format')result.imagePasteProof.imageFormat='gif';if(kind==='proof-id')result.imagePasteProof.id='bad';if(kind==='proof-extra')result.imagePasteProof.attachmentLoaded=true;if(kind==='clipboard')result.clipboardRestored=false;
      if(kind==='frame-missing')delete result.postPasteFrame;if(kind==='marker')delete result.postPasteFrame.uiaControlFrame;if(kind==='pid')result.postPasteFrame.binding.pid++;if(kind==='thread')result.postPasteFrame.binding.threadId++;if(kind==='revision')result.postPasteFrame.revision++;if(kind==='send-region')result.postPasteFrame.regions[2].rect.left++;if(kind==='pixel-hash')result.postPasteFrame.regions[0].rgbaSha256='b'.repeat(64);
    }return result;};
    await assert.rejects(f.driver.pasteImage(f.job,guard,{canInput:()=>true}),error=>error.attempted===true,kind);
    assert.equal(f.driver.current,null,kind);assert.deepEqual(f.driver.draftHold,{account:f.job.account,target:f.job.target});assert.equal((await f.driver.pasteImage(f.job,guard,{canInput:()=>true})).performed,false);
    assert.equal(f.actions.filter(a=>a.action==='pasteUiaImage').length,1);assert.equal(f.actions.some(a=>a.action==='submitUiaImage'),false);await f.driver.releaseTextFocus();
  }
});

test('UIA image submission rejects missing or changed conversation evidence without repasting',async t=>{
  for(const kind of ['missing','changed','provider','cleanup']){
    const f=await uiaImageFixture(t);await f.driver.pasteImage(f.job,await f.driver.observe(f.job),{canInput:()=>true});const verify=f.driver.verifyControls;
    f.driver.verifyControls=async options=>{const proof=await verify(options);if(options.operation==='image-submit'){if(kind==='missing')delete proof.conversationFingerprint;if(kind==='changed')proof.conversationFingerprint.sha256='f'.repeat(64);if(kind==='provider'||kind==='cleanup')throw Object.assign(Error('refused'),{code:kind==='cleanup'?'UIA_MODE_VERIFIER_CLEANUP_UNCONFIRMED':'UIA_MODE_RESULT_UNCONFIRMED',attempted:false});}return proof;};
    await assert.rejects(f.driver.submitImage(f.job,await f.driver.observe(f.job),{canSubmit:()=>true}));
    assert.equal(f.actions.filter(a=>a.action==='pasteUiaImage').length,1);assert.equal(f.actions.some(a=>a.action==='submitUiaImage'),false);assert.equal(f.driver.textFocusLease,null);
    assert.equal((await f.driver.pasteImage(f.job,{}, {canInput:()=>true})).performed,false);
  }
});

test('UIA image uncertain native submission permanently consumes the JS single-submit barrier',async t=>{
  const f=await uiaImageFixture(t);await f.driver.pasteImage(f.job,await f.driver.observe(f.job),{canInput:()=>true});const guard=await f.driver.observe(f.job),request=f.driver.client.request;
  f.driver.client.request=async(action,input)=>{if(action==='submitUiaImage'){await request(action,input);throw Object.assign(Error('uncertain'),{code:'QT_INPUT_UNCERTAIN',attempted:true});}return request(action,input);};
  await assert.rejects(f.driver.submitImage(f.job,guard,{canSubmit:()=>true}),{code:'QT_INPUT_UNCERTAIN'});
  assert.equal(f.driver.canResumeImage(f.job),false);assert.equal((await f.driver.submitImage(f.job,guard,{canSubmit:()=>true})).performed,false);assert.equal(f.actions.filter(a=>a.action==='submitUiaImage').length,1);assert.equal(f.driver.textFocusLease,null);
});

test('UIA image queue evidence never claims a confirmed send and malformed evidence cannot trigger resubmission',async t=>{
  for(const kind of ['scope','count','queue','cursor','completion','confirmed','submitted','missing']){
    const f=await uiaImageFixture(t);await f.driver.pasteImage(f.job,await f.driver.observe(f.job),{canInput:()=>true});const guard=await f.driver.observe(f.job),request=f.driver.client.request;
    f.driver.client.request=async(action,input)=>{const result=await request(action,input);if(action==='submitUiaImage'){
      const p=result.pointerDelivery;if(kind==='scope')p.scope='editor-focus';if(kind==='count')p.messagesPosted=2;if(kind==='queue')p.queueAccepted=false;if(kind==='cursor')p.cursorUnchanged=false;if(kind==='completion')p.completion='uia-focus';if(kind==='confirmed')result.submissionConfirmed=true;if(kind==='submitted')result.submitted=true;if(kind==='missing')delete result.pointerDelivery;
    }return result;};
    await assert.rejects(f.driver.submitImage(f.job,guard,{canSubmit:()=>true}),{code:'UI_QT_IMAGE_SUBMIT_UNCONFIRMED'},kind);
    assert.equal((await f.driver.submitImage(f.job,guard,{canSubmit:()=>true})).performed,false,kind);assert.equal(f.actions.filter(a=>a.action==='submitUiaImage').length,1,kind);assert.equal(f.driver.textFocusLease,null,kind);
  }
});

test('UIA image resume rebinds only its original native proof with fresh account and conversation, without screenshots or repaste',async t=>{
  for(const changed of [false,true]){
    const f=await uiaImageFixture(t);await f.driver.pasteImage(f.job,await f.driver.observe(f.job),{canInput:()=>true});const proof=structuredClone(f.driver.current.uiaImageProof);await f.driver.releaseTextFocus();f.actions.length=0;f.checks.length=0;
    if(changed)f.imageState.revision++;
    if(changed){await assert.rejects(f.driver.resumeImage(f.job,{canInput:()=>true}),{code:'QT_UIA_IMAGE_PROOF_INVALID'});assert.equal(f.actions.some(a=>a.action==='submitUiaImage'),false);}
    else{assert.deepEqual(await f.driver.resumeImage(f.job,{canInput:()=>true}),{ready:true,imageResume:true});assert.deepEqual(f.driver.current.uiaImageProof,proof);assert.deepEqual(f.checks.map(c=>c.operation),['image-resume']);assert.equal((await f.driver.submitImage(f.job,await f.driver.observe(f.job),{canSubmit:()=>true})).performed,true);}
    assert.equal(f.actions.some(a=>['capture','pasteImage','pasteUiaImage','click','readDraft'].includes(a.action)),false);await f.driver.releaseTextFocus();
  }
});

test('UIA first voice preparation keeps current conversation evidence through voice-start and transfers a fresh account proof',async t=>{
  for(const changed of [false,true]){
    const f=uiaFirstNavigationFixture(t,{mutateProof:(proof,options)=>{if(changed&&options.operation==='voice-start')proof.conversationFingerprint.sha256='f'.repeat(64);}});f.driver.config.voice={...adaptiveVoiceCalibration(),toolbarRect:adaptiveVoiceCalibration().recordingUi.adaptive.toolbarRect,recordingUi:{focusHwnd:'same',uia:{version:1,executableVersion:'4.1.15.56'}}};
    if(changed){await assert.rejects(f.driver.prepareVoiceSession(f.job,f.plan),{code:'UI_QT_HEADER_CHANGED'});assert.equal(f.actions.some(a=>a.action==='transferFocusHandoff'),false);assert.equal(f.actions.filter(a=>a.action==='releaseFocusHandoff').length,1);}
    else{const session=await f.driver.prepareVoiceSession(f.job,f.plan);assert.equal(session.session.draftPolicy,'unchecked');assert.equal(session.session.emptyDraftConfirmed,false);validateAccountEvidence(session.accountProof.evidence,{pid:42,processCreatedFileTimeUtc:'12345'},f.driver.now());assert.equal(f.actions.filter(a=>a.action==='transferFocusHandoff').length,1);assert.equal((await session.releaseFocus()).restored,true);}
    assert.deepEqual(f.checks.map(c=>c.operation),['navigation-ready','voice-start']);assert.equal(f.actions.some(a=>['searchEnter','readDraft'].includes(a.action)),false);
  }
});

test('UIA voice config and transferred session omit an unused mouse parking rectangle without inventing one',async t=>{
  const f=uiaFirstNavigationFixture(t),calibration=adaptiveVoiceCalibration();
  f.driver.config.voice={recordStartRect:calibration.recordStartRect,toolbarRect:calibration.recordingUi.adaptive.toolbarRect,recordingUi:{focusHwnd:'same',uia:{version:1,executableVersion:'4.1.15.56'}}};
  const checked=validateQtConfig(f.driver.config);assert.equal(Object.hasOwn(checked.voice,'mouseParkRect'),false);
  const prepared=await f.driver.prepareVoiceSession(f.job,f.plan);assert.equal(Object.hasOwn(prepared.session,'mouseParkRect'),false);assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(prepared.session)),'mouseParkRect'),false);assert.equal(prepared.session.recordingUi.uia.version,1);await prepared.releaseFocus();
  for(const park of [null,{},r(600,500,610,510)]){const config=structuredClone(checked);config.voice.mouseParkRect=park;assert.throws(()=>validateQtConfig(config),{code:'UI_QT_VOICE_CALIBRATION_REQUIRED'});}
  const ocr=fixture(t);ocr.driver.config.voice=voiceCalibration();delete ocr.driver.config.voice.mouseParkRect;assert.deepEqual(await ocr.driver.prepareVoiceHandoff(ocr.job),{ready:false,reason:'UI_QT_VOICE_CALIBRATION_REQUIRED'});assert.equal(ocr.actions.length,0);
});

test('UIA focus resume accepts a fresh optional caption only within the original UIA lease and return identity',async t=>{
  const caption=left=>({rect:r(left,2,left+40,14),mode:'uia-caption-v1'});
  for(const [before,after] of [[undefined,caption(400)],[caption(400),caption(450)],[caption(400),undefined],[undefined,undefined]]){
    const f=uiaFirstNavigationFixture(t);await f.driver.prepare(f.job,f.plan);const lease=f.driver.textFocusLease,request=f.driver.client.request;
    if(before)lease.handoff.activation=before;else delete lease.handoff.activation;
    f.driver.client.request=async(action,input)=>{const result=await request(action,input);if(action==='resumeFocusHandoff'){if(after)result.focusHandoff.activation=after;else delete result.focusHandoff.activation;}return result;};
    assert.deepEqual(await f.driver.withPreparationFocusParked(async()=>({readOnly:true})),{readOnly:true});assert.equal(lease.parked,false);assert.deepEqual(lease.handoff.activation,after);assert.equal(f.actions.filter(a=>a.action==='resumeFocusHandoff').length,1);await f.driver.releaseTextFocus();
  }
});

test('lazy UIA caption lookup cannot change lease mode or return identity and cannot weaken OCR resume',async t=>{
  for(const kind of ['return','blank','pixels','invalid-rect','mode-changed','ocr']){
    const f=kind==='ocr'?fixture(t,withObservedPopups):uiaFirstNavigationFixture(t);await f.driver.prepare(f.job,{interactionPlan:{executionMode:'focus-handoff'}});const request=f.driver.client.request;
    f.driver.client.request=async(action,input)=>{const result=await request(action,input);if(action==='resumeFocusHandoff'){
      if(kind==='return')result.focusHandoff.returnWindow.pid++;
      else if(kind==='mode-changed')f.driver.config.layoutMode='adaptive-v1';
      else result.focusHandoff.activation=kind==='pixels'?{rect:r(400,2,440,14),rgbaSha256:'a'.repeat(64)}:{rect:kind==='invalid-rect'?r(1,2,40,14):r(400,2,440,14),mode:kind==='blank'||kind==='ocr'?'blank-caption-v1':'uia-caption-v1'};
    }return result;};
    await assert.rejects(f.driver.withPreparationFocusParked(async()=>{}),{code:'UI_QT_FOCUS_LEASE_INVALID'});assert.equal(f.actions.filter(a=>a.action==='resumeFocusHandoff').length,1);await f.driver.releaseTextFocus();
  }
});

test('UIA fast cold navigation uses one read-only purpose-bound snapshot and opens only fixed search without pixel retries',async t=>{
  const f=uiaFastNavigationFixture(t,{opening:(_input,current)=>{
    assert.equal(current.actions.filter(a=>a.action==='captureUiaNavigation').length,1);
    assert.equal(current.actions.some(a=>['capture','chord','paste','type','click'].includes(a.action)),false);
  }});
  f.driver.warmOcr=f.driver.recognize=async()=>{assert.fail('UIA shared search must not run OCR');};
  const begin=f.clock.value;let openingAt;
  const request=f.driver.client.request;f.driver.client.request=async(action,input)=>{if(action==='openUiaSearch')openingAt=f.clock.value;return request(action,input);};
  assert.equal((await f.driver.prepare(f.job,f.plan)).ready,true);
  assert.equal(openingAt,begin);assert.equal(f.actions.filter(a=>a.action==='captureUiaNavigation').length,1);assert.equal(f.actions.filter(a=>a.action==='openUiaSearch').length,1);
  assert.equal(f.actions.some(a=>a.action==='chord'),false);assert.equal(f.actions.filter(a=>a.action==='searchEnter').length,1);
  assert.equal(f.actions.some(a=>a.action==='paste'&&a.scope==='editor'||a.action==='submitTextEnter'),false);
});

test('UIA fast snapshot refuses invalid purpose, geometry, activity and cancellation before opening search',async t=>{
  for(const kind of ['navigation-only','stable-marker','observation-kind','input-sent','region','dpi','position','pid','idle','cancel','native-activity','native-pixels']){
    const abort=new AbortController();const f=uiaFastNavigationFixture(t,{snapshot:(frame)=>{
      if(kind==='navigation-only')delete frame.navigationOnly;if(kind==='stable-marker')frame.baselinePixelStable=true;
      if(kind==='observation-kind')frame.observationKind='other';if(kind==='input-sent')frame.inputSent=true;
      if(kind==='region')frame.regions[0].rect.right++;if(kind==='dpi')frame.binding.dpi++;
      if(kind==='position'){frame.binding.captureRect.left++;frame.binding.captureRect.right++;}if(kind==='pid')frame.binding.pid++;
      if(kind==='idle')frame.idleMs=0;if(kind==='cancel')abort.abort();
      if(kind.startsWith('native-'))throw Object.assign(Error('native refusal'),{code:kind==='native-activity'?'QT_HUMAN_ACTIVITY_CHANGED':'QT_PIXELS_CHANGED',attempted:false,pixelMismatch:{stage:'capture',anchorIndex:0}});
    }});
    let outcome;try{outcome=await f.driver.prepare(f.job,{...f.plan,signal:abort.signal});}catch(error){outcome={ready:false,reason:error.code};}
    assert.equal(outcome?.ready,false,kind);assert.equal(f.actions.filter(a=>a.action==='captureUiaNavigation').length,1,kind);
    assert.equal(f.actions.some(a=>['openUiaSearch','chord','paste','type','searchEnter','submitTextEnter'].includes(a.action)),false,kind);
    assert.equal(f.actions.filter(a=>a.action==='releaseFocusHandoff').length,1,kind);
  }
});

test('UIA fast opening has no input retry even for a definitely unexecuted pixel rejection',async t=>{
  const f=uiaFastNavigationFixture(t,{opening:()=>{throw Object.assign(Error('refused'),{code:'QT_PIXELS_CHANGED',attempted:false,pixelMismatch:{stage:'guard',anchorIndex:0}});}});let openings=0;
  const request=f.driver.client.request;f.driver.client.request=async(action,input)=>{if(action==='openUiaSearch')openings++;return request(action,input);};
  let result;try{result=await f.driver.prepare(f.job,f.plan);}catch(error){result={ready:false,reason:error.code};}
  assert.equal(result.ready,false);assert.equal(openings,1);assert.equal(f.actions.filter(a=>a.action==='captureUiaNavigation').length,1);
  assert.equal(f.actions.some(a=>['chord','paste','searchEnter'].includes(a.action)),false);
});

test('UIA fast opening requires the complete native purpose acknowledgement before pasting a query',async t=>{
  for(const key of ['openedSearch','navigationOnly','baselinePixelStable']){
    const f=uiaFastNavigationFixture(t,{opened:result=>{delete result[key];}});let result;
    try{result=await f.driver.prepare(f.job,f.plan);}catch(error){result={ready:false,reason:error.code};}
    assert.equal(result.ready,false,key);assert.equal(f.actions.filter(a=>a.action==='openUiaSearch').length,1);
    assert.equal(f.actions.some(a=>['paste','searchEnter','submitTextEnter'].includes(a.action)),false,key);
  }
});

test('an unstable UIA baseline cannot use a later changed header to bypass the search presentation grace',async t=>{
  const f=uiaFastNavigationFixture(t),request=f.driver.client.request;let enteredAt,clickedAt;
  f.driver.client.request=async(action,input)=>{const result=await request(action,input);if(action==='searchEnter'){enteredAt=f.clock.value;f.setHeader('b'.repeat(64));}if(action==='click')clickedAt??=f.clock.value;return result;};
  assert.equal((await f.driver.prepare(f.job,f.plan)).ready,true);
  assert.ok(clickedAt-enteredAt>=350);assert.equal(f.driver.current.header,'b'.repeat(64));
});

test('UIA control verification alone keeps the existing pixel navigation unless the explicit fast policy is present',async t=>{
  const f=uiaFastNavigationFixture(t,{policy:'pixels-v1'});assert.equal((await f.driver.prepare(f.job,f.plan)).ready,true);
  assert.equal(f.actions.some(a=>['captureUiaNavigation','openUiaSearch'].includes(a.action)),false);
  assert.equal(f.actions.filter(a=>a.action==='chord'&&a.key==='Control+F').length,1);
  for(const navigationPolicy of ['unknown',null])assert.throws(()=>new QtVisualDriver({root:f.driver.root,config:f.driver.config,client:f.driver.client,verifyControls:async()=>({}),navigationPolicy}),{code:'UI_QT_DRIVER_OPTIONS_INVALID'});
  assert.throws(()=>new QtVisualDriver({root:f.driver.root,config:f.driver.config,client:f.driver.client,navigationPolicy:'uia-controls-v1'}),{code:'UI_QT_DRIVER_OPTIONS_INVALID'});
});

const fastConversationFingerprint=()=>({version:1,scope:'chat-title-text-v1',sha256:'a'.repeat(64),headerRuntimeIdSha256:'b'.repeat(64),titleRuntimeIdSha256:'c'.repeat(64),textNodeCount:1,targetVerified:false});
async function completedFastNavigationFixture(t,options={}){
  const f=uiaFastNavigationFixture(t,options),checks=[];let fingerprint=Object.hasOwn(options,'initialFingerprint')?options.initialFingerprint:fastConversationFingerprint();
  f.driver.controlVerificationPolicy='input-boundaries-v1';
  f.driver.verifyControls=async({operation})=>{checks.push(operation);return{verified:true,proof:'uia-controls-v1',...(fingerprint!==undefined?{conversationFingerprint:structuredClone(fingerprint)}:{})};};
  assert.equal((await f.driver.prepare(f.job,f.plan)).ready,true);let observed=await f.driver.observe(f.job);
  assert.equal((await f.driver.pasteText(f.job,{expectedDraft:'',text:'已发送正文',editorToken:observed.editorToken,activityRevision:observed.activityRevision},{canInput:()=>true})).performed,true);
  observed=await f.driver.observe(f.job);assert.equal((await f.driver.submit(f.job,{expectedDraft:'已发送正文',editorToken:observed.editorToken,activityRevision:observed.activityRevision},{canSubmit:()=>true})).performed,true);
  const submitted=f.actions.findLast(action=>action.action==='submitTextEnter');assert.ok(submitted);
  if(options.allowBackgroundText===true)assert.equal(submitted.retainBackgroundEditor,true);else assert.equal(Object.hasOwn(submitted,'retainBackgroundEditor'),false);
  f.setDraft('');f.setEditor('e'.repeat(64));f.actions.length=0;f.waits.length=0;checks.length=0;
  return{...f,checks,next:{...f.job,id:'7'.repeat(64),text:'下一条正文'},setFingerprint:value=>{fingerprint=value;}};
}

async function backgroundTextFixture(t,{prepare,write,submit,release}={}){
  const f=await completedFastNavigationFixture(t,{allowBackgroundText:true}),request=f.driver.client.request;
  f.driver.config=validateQtConfig(uiaFirstConfig(f.driver.config));f.plan.textEntryMode='paste';
  f.driver.resolveTarget=async job=>({wechatId:job.target,alias:'target_A',name:'目标',ambiguous:false,uniqueSearchName:true,searchName:'唯一联系人'});
  const leaseId='a'.repeat(32),frame=state=>({backgroundLeaseId:leaseId,token:state==='empty'?'4'.repeat(32):'5'.repeat(32),epoch:'2'.repeat(32),revision:0,idleMs:2000,
    observationKind:'uia-background-metadata-v1',pixelsRead:false,inputTransport:'window-message-background-v1',editorState:state,conversationFingerprint:fastConversationFingerprint(),
    binding:{hwnd:'100',pid:42,threadId:7,processCreatedFileTimeUtc:'12345',dpi:96,foreground:false,clientRect:r(0,0,800,600),captureRect:r(10,10,810,610),focusHwnd:'0',lastInputTick:100},
    regions:['header','editor','send'].map(role=>({role,rect:structuredClone(f.driver.config.layout[role]),controlSha256:digest(role)}))});
  f.driver.client.request=async(action,input)=>{
    if(!['prepareUiaBackgroundText','writeUiaBackgroundText','submitUiaBackgroundText','releaseUiaBackgroundText'].includes(action))return request(action,input);
    f.actions.push({action,...structuredClone(input)});
    if(action==='prepareUiaBackgroundText'){
      assert.deepEqual(input.conversationFingerprint,fastConversationFingerprint());assert.equal(input.stepBinding.deliveryId,f.next.id);assert.equal(input.checkpoint.binding.foreground,undefined);
      const result={ready:true,reason:null,readOnly:true,inputSent:false,attempted:false,focusChanged:false,clipboardAccessed:false,backgroundLeaseId:leaseId,frame:frame('empty')};return prepare?await prepare(result,input,f):result;
    }
    assert.equal(input.backgroundLeaseId,leaseId);
    if(action==='writeUiaBackgroundText'){
      assert.equal(input.text,input.expectedText);assert.equal(input.text,f.next.text);assert.equal(input.token,'4'.repeat(32));assert.equal(input.stepBinding.deliveryId,f.next.id);
      const result={performed:true,attempted:true,textTransport:'window-message-background-v1',valueConfirmed:true,clipboardAccessed:false,intendedText:input.text,readbackPerformed:false,interrupted:false,postPasteFrame:frame('own-text'),textEnterProof:{version:1,id:'b'.repeat(32),textSha256:digest(input.text)}};return write?await write(result,input,f):result;
    }
    if(action==='submitUiaBackgroundText'){
      assert.equal(input.token,'5'.repeat(32));assert.equal(input.textEnterProofId,'b'.repeat(32));assert.equal(input.textSha256,digest(f.next.text));const result={performed:true,attempted:true,inputQueued:true,submissionConfirmed:false,messagesPosted:3,inputTransport:'window-message-background-v1',foregroundChanged:false,clipboardAccessed:false,editorEmptyAfterSubmit:true,consumptionConfirmed:true};return submit?await submit(result,input,f):result;
    }
    const result={released:true,backgroundLeaseId:leaseId,inputSent:false,focusChanged:false};return release?await release(result,input,f):result;
  };
  return f;
}
const backgroundPaste=async f=>{const observed=await f.driver.observe(f.next);return f.driver.pasteText(f.next,{expectedDraft:'',text:f.next.text,editorToken:observed.editorToken,activityRevision:observed.activityRevision},{canInput:()=>true});};

test('background text constructor permission defaults to false and accepts only actual booleans',t=>{
  const f=fixture(t);assert.equal(f.driver.allowBackgroundText,false);
  for(const value of [null,0,1,'true','false',{},[],new Boolean(true)])assert.throws(()=>new QtVisualDriver({root:f.driver.root,config:config(),client:f.driver.client,allowBackgroundText:value}),{code:'UI_QT_DRIVER_OPTIONS_INVALID'});
  for(const value of [true,false])assert.equal(new QtVisualDriver({root:f.driver.root,config:config(),client:f.driver.client,allowBackgroundText:value}).allowBackgroundText,value);
});

test('UIA default same-chat continuation sends no background command even with complete cached evidence',async t=>{
  const f=await completedFastNavigationFixture(t);assert.equal(f.driver.allowBackgroundText,false);f.driver.config=validateQtConfig(uiaFirstConfig(f.driver.config));f.driver.config.allowBackgroundText=true;f.next.allowBackgroundText=true;
  f.driver.resolveTarget=async job=>({wechatId:job.target,alias:'target_A',name:'目标',ambiguous:false,uniqueSearchName:true,searchName:'唯一联系人'});f.plan.textEntryMode='paste';
  assert.equal((await f.driver.prepare(f.next,{...f.plan,allowBackgroundText:true})).ready,true);const before=await f.driver.observe(f.next);assert.equal(before.foreground,true);assert.equal(before.inputTransport,undefined);
  assert.equal((await backgroundPaste(f)).performed,true);const after=await f.driver.observe(f.next);assert.equal((await f.driver.submit(f.next,{expectedDraft:f.next.text,editorToken:after.editorToken,activityRevision:after.activityRevision},{canSubmit:()=>true})).performed,true);
  assert.equal(f.actions.some(a=>['prepareUiaBackgroundText','writeUiaBackgroundText','submitUiaBackgroundText','releaseUiaBackgroundText'].includes(a.action)),false);assert.equal(f.actions.filter(a=>a.action==='submitTextEnter').length,1);assert.equal(Object.hasOwn(f.actions.find(a=>a.action==='submitTextEnter'),'retainBackgroundEditor'),false);assert.equal(f.actions.filter(a=>a.action==='releaseFocusHandoff').length,1);
});

test('verified same-chat UIA text uses honest background metadata, receipt barrier and an independent lease without taking foreground',async t=>{
  const f=await backgroundTextFixture(t);assert.deepEqual(await f.driver.prepare(f.next,f.plan),{ready:true,inputTransport:'window-message-background-v1'});
  assert.deepEqual(f.actions.map(a=>a.action),['prepareUiaBackgroundText']);assert.equal(f.driver.textFocusLease,null);
  const observed=await f.driver.observe(f.next);assert.equal(observed.foreground,false);assert.equal(observed.inputTransport,'window-message-background-v1');assert.equal(observed.draft,'');
  assert.deepEqual(await backgroundPaste(f),{performed:true,attempted:true});const pasted=await f.driver.observe(f.next);assert.equal(pasted.foreground,false);assert.equal(pasted.draft,f.next.text);
  let entered,finish;const waiting=new Promise(resolve=>{entered=resolve;});const pending=f.driver.submit(f.next,{expectedDraft:f.next.text,editorToken:pasted.editorToken,activityRevision:pasted.activityRevision},{canSubmit:()=>true,beforeSubmit:()=>{entered();return new Promise(resolve=>{finish=resolve;});}});
  await waiting;assert.equal(f.actions.some(a=>a.action==='submitUiaBackgroundText'),false);finish({ready:true,proof:'receipt-baseline-persisted-v1'});assert.deepEqual(await pending,{performed:true,attempted:true});
  assert.deepEqual(await f.driver.releaseTextFocus(),{released:true,backgroundReleased:true,foregroundBorrowed:false,restored:false,skipped:true,foregroundIntervals:[]});
  assert.deepEqual(f.actions.map(a=>a.action),['prepareUiaBackgroundText','writeUiaBackgroundText','submitUiaBackgroundText','releaseUiaBackgroundText']);
});

test('background preparation falls back only on an explicit native read-only no-input refusal',async t=>{
  const f=await backgroundTextFixture(t,{prepare:()=>({ready:false,reason:'QT_UIA_BACKGROUND_EDITOR_NOT_EMPTY',readOnly:true,inputSent:false,attempted:false,focusChanged:false,clipboardAccessed:false})});
  assert.equal((await f.driver.prepare(f.next,f.plan)).ready,true);assert.equal(f.actions[0].action,'prepareUiaBackgroundText');assert.ok(f.actions.some(a=>a.action==='beginFocusHandoff'));assert.equal(f.driver.draftHold,null);
});

test('background eligibility never adopts a different recipient, stale checkpoint or unsupported body',async t=>{
  for(const kind of ['target','expired','clock-reversed','account-ref','pending','index','newline','format','humanized']){
    const f=await backgroundTextFixture(t);if(kind==='target')f.next.target='wxid_other';if(kind==='expired')f.clock.value+=30001;if(kind==='clock-reversed')f.clock.value--;if(kind==='account-ref')f.driver.config.accountRef='9'.repeat(64);if(kind==='pending')f.next.pendingInput={};if(kind==='index')f.next.index=1;if(kind==='newline')f.next.text='a\nb';if(kind==='format')f.next.text='a\u200bb';if(kind==='humanized')f.plan.textEntryMode='humanized';
    try{await f.driver.prepare(f.next,f.plan);}catch{}assert.equal(f.actions.some(a=>a.action==='prepareUiaBackgroundText'),false,kind);
  }
});

test('unknown background preparation cannot acquire foreground or silently retry another route',async t=>{
  for(const kind of ['unknown','attempted','frame','foreground','fingerprint']){
    const f=await backgroundTextFixture(t,{prepare:result=>{if(kind==='unknown')throw Object.assign(Error('unknown'),{code:'QT_PIPE_CLOSED'});if(kind==='attempted')return{ready:false,readOnly:true,inputSent:true,attempted:true,focusChanged:false,clipboardAccessed:false,reason:'QT_FAILED'};if(kind==='frame')delete result.frame.editorState;if(kind==='foreground')result.frame.binding.foreground=true;if(kind==='fingerprint')result.frame.conversationFingerprint.sha256='f'.repeat(64);return result;}});
    await assert.rejects(f.driver.prepare(f.next,f.plan));assert.equal(f.actions.some(a=>a.action==='beginFocusHandoff'),false,kind);assert.ok(f.driver.draftHold,kind);
    assert.equal((await f.driver.prepare(f.next,f.plan)).ready,false);assert.equal(f.actions.filter(a=>a.action==='prepareUiaBackgroundText').length,1,kind);
  }
});

test('a read-only background account-probe failure releases its lease without retaining a phantom draft',async t=>{
  const f=await backgroundTextFixture(t);f.driver.probeAccount=async()=>{throw Object.assign(Error('temporary'),{code:'UI_ACCOUNT_SNAPSHOT_UNSTABLE'});};
  await assert.rejects(f.driver.prepare(f.next,f.plan),{code:'UI_ACCOUNT_SNAPSHOT_UNSTABLE'});assert.equal(f.driver.draftHold,null);assert.equal(f.actions.filter(a=>a.action==='releaseUiaBackgroundText').length,1);assert.equal(f.actions.some(a=>a.action==='beginFocusHandoff'),false);
});

test('background write uncertainty consumes the route and cannot repaste or submit through foreground',async t=>{
  for(const kind of ['unknown','bad-ack','bad-frame','bad-proof']){
    const f=await backgroundTextFixture(t,{write:result=>{if(kind==='unknown')throw Object.assign(Error('unknown'),{code:'QT_PIPE_CLOSED'});if(kind==='bad-ack')result.valueConfirmed=false;if(kind==='bad-frame')result.postPasteFrame.revision++;if(kind==='bad-proof')result.textEnterProof.textSha256='f'.repeat(64);return result;}});
    await f.driver.prepare(f.next,f.plan);await assert.rejects(backgroundPaste(f));assert.ok(f.driver.draftHold,kind);assert.equal((await f.driver.prepare(f.next,f.plan)).ready,false);assert.equal(f.actions.filter(a=>a.action==='writeUiaBackgroundText').length,1);assert.equal(f.actions.some(a=>['beginFocusHandoff','submitUiaBackgroundText'].includes(a.action)),false);
  }
});

test('background submit waits preserve cancellation, permission and original transaction authority',async t=>{
  for(const kind of ['invalid','failed','aborted','permission','transaction']){
    const f=await backgroundTextFixture(t),abort=new AbortController();let allowed=true;await f.driver.prepare(f.next,f.plan);await backgroundPaste(f);const observed=await f.driver.observe(f.next);
    const result=await f.driver.submit(f.next,{expectedDraft:f.next.text,editorToken:observed.editorToken,activityRevision:observed.activityRevision,signal:abort.signal},{canSubmit:()=>allowed,beforeSubmit:async()=>{if(kind==='failed')throw Error('receipt unavailable');if(kind==='aborted')abort.abort();if(kind==='permission')allowed=false;if(kind==='transaction')f.driver.transaction.revision++;return kind==='invalid'?{ready:true}:{ready:true,proof:'receipt-baseline-persisted-v1'};}});
    assert.equal(result.performed,false,kind);assert.equal(result.attempted,false,kind);assert.equal(f.actions.some(a=>a.action==='submitUiaBackgroundText'),false,kind);assert.equal(f.actions.filter(a=>a.action==='releaseUiaBackgroundText').length,1,kind);
  }
});

test('background submission accepts only the exact native delivery acknowledgment and never retries uncertain input',async t=>{
  for(const patch of [{messagesPosted:2},{messagesPosted:4},{messagesPosted:'3'},{messagesPosted:undefined},{inputTransport:'window-message-v1'},{inputTransport:undefined},{foregroundChanged:true},{foregroundChanged:undefined},{clipboardAccessed:true},{clipboardAccessed:undefined},{inputQueued:false},{submissionConfirmed:true},{submitted:true},{editorEmptyAfterSubmit:false},{editorEmptyAfterSubmit:undefined},{editorEmptyAfterSubmit:1},{consumptionConfirmed:false},{consumptionConfirmed:undefined},{consumptionConfirmed:'true'}]){
    const f=await backgroundTextFixture(t,{submit:result=>Object.assign(result,patch)});await f.driver.prepare(f.next,f.plan);await backgroundPaste(f);const observed=await f.driver.observe(f.next),guard={expectedDraft:f.next.text,editorToken:observed.editorToken,activityRevision:observed.activityRevision};
    await assert.rejects(f.driver.submit(f.next,guard,{canSubmit:()=>true,beforeSubmit:async()=>({ready:true,proof:'receipt-baseline-persisted-v1'})}),{code:'UI_QT_BACKGROUND_INPUT_UNCERTAIN',attempted:true});
    assert.equal(f.driver.textSubmitAttempted,f.next.id);assert.ok(f.driver.draftHold);assert.equal(f.actions.filter(a=>a.action==='releaseUiaBackgroundText').length,1);
    assert.equal((await f.driver.submit(f.next,guard,{canSubmit:()=>true})).performed,false);assert.equal(f.actions.filter(a=>a.action==='submitUiaBackgroundText').length,1);assert.equal(f.actions.some(a=>a.action==='beginFocusHandoff'),false);
  }
});

test('UIA semantic same-chat continuation ignores redraw pixels and uses one purpose-bound editor focus snapshot without search or waits',async t=>{
  const f=await completedFastNavigationFixture(t);f.setHeader('f'.repeat(64));
  assert.equal((await f.driver.prepare(f.next,f.plan)).ready,true);
  assert.deepEqual(f.actions.map(a=>a.action),['inspectFocusHandoff','inspectLayout','beginFocusHandoff','captureUiaNavigation','focusUiaEditor']);
  assert.deepEqual(f.waits,[]);assert.deepEqual(f.checks,['navigation-continuation']);assert.equal(f.driver.current.header,f.driver.frame.regions[0].controlSha256);assert.equal(f.driver.frame.regions[0].rgbaSha256,undefined);
  assert.deepEqual(f.driver.current.uiaConversationFingerprint,fastConversationFingerprint());assert.equal(f.driver.current.textEnterProof,undefined);assert.equal(f.driver.current.draft,'');
  let observed=await f.driver.observe(f.next);assert.equal((await f.driver.pasteText(f.next,{expectedDraft:'',text:f.next.text,editorToken:observed.editorToken,activityRevision:observed.activityRevision},{canInput:()=>true})).performed,true);
  observed=await f.driver.observe(f.next);assert.equal((await f.driver.submit(f.next,{expectedDraft:f.next.text,editorToken:observed.editorToken,activityRevision:observed.activityRevision},{canSubmit:()=>true})).performed,true);
  assert.deepEqual(f.checks,['navigation-continuation','text-input','text-submit']);assert.equal(f.actions.filter(a=>a.action==='submitTextEnter').length,1);
});

test('UIA semantic continuation falls back to cold search for missing or changed fingerprints and target or checkpoint changes',async t=>{
  for(const kind of ['fingerprint','header-runtime','title-runtime','missing','target','account-ref','epoch','revision','thread','position','expired','clock-reversed']){
    const f=await completedFastNavigationFixture(t),request=f.driver.client.request,probe=f.driver.probeAccount;
    if(kind==='missing')f.setFingerprint(undefined);
    if(['fingerprint','header-runtime','title-runtime'].includes(kind)){const proof=fastConversationFingerprint();proof[kind==='fingerprint'?'sha256':kind==='header-runtime'?'headerRuntimeIdSha256':'titleRuntimeIdSha256']='d'.repeat(64);f.setFingerprint(proof);}
    if(kind==='target')f.next.target='wxid_other';if(kind==='account-ref')f.driver.config.accountRef='d'.repeat(64);if(kind==='revision')f.setRevision(1);
    if(kind==='expired')f.clock.value+=30001;if(kind==='clock-reversed')f.clock.value--;
    f.driver.probeAccount=async input=>{const result=await probe(input);result.accountRef=result.accountScopeHash=input.expectedAccountRef;return result;};
    f.driver.client.request=async(action,input)=>{const result=structuredClone(await request(action,input));
      if(kind==='epoch'&&['capture','captureUiaNavigation'].includes(action))result.epoch='3'.repeat(32);
      if(result.binding){if(kind==='thread')result.binding.threadId++;if(kind==='position'){result.binding.captureRect.left++;result.binding.captureRect.right++;}}
      return result;
    };
    assert.equal((await f.driver.prepare(f.next,f.plan)).ready,true,kind);
    assert.equal(f.actions.filter(a=>a.action==='openUiaSearch').length,1,kind);assert.equal(f.actions.filter(a=>a.action==='searchEnter').length,1,kind);
    assert.equal(f.actions.some(a=>a.action==='focusUiaEditor'||a.action==='paste'&&a.scope==='editor'||a.action==='submitTextEnter'),false,kind);
  }
});

test('a completed chat without cached semantic evidence cannot adopt a fresh fingerprint to skip navigation',async t=>{
  const f=await completedFastNavigationFixture(t,{initialFingerprint:undefined});f.setFingerprint(fastConversationFingerprint());
  assert.equal((await f.driver.prepare(f.next,f.plan)).ready,true);assert.equal(f.actions.filter(a=>a.action==='openUiaSearch').length,1);
  assert.equal(f.actions.some(a=>a.action==='focusUiaEditor'),false);assert.equal(f.checks.includes('navigation-continuation'),false);
});

test('UIA semantic continuation cannot change its title fingerprint between navigation and body input or between paste and submit',async t=>{
  for(const boundary of ['text-input','text-submit'])for(const changed of ['different','missing']){
    const f=await completedFastNavigationFixture(t);assert.equal((await f.driver.prepare(f.next,f.plan)).ready,true);let observed=await f.driver.observe(f.next);
    if(boundary==='text-submit'){assert.equal((await f.driver.pasteText(f.next,{expectedDraft:'',text:f.next.text,editorToken:observed.editorToken,activityRevision:observed.activityRevision},{canInput:()=>true})).performed,true);observed=await f.driver.observe(f.next);}
    f.setFingerprint(changed==='missing'?undefined:{...fastConversationFingerprint(),sha256:'d'.repeat(64)});const before=f.actions.length;
    const result=boundary==='text-input'?await f.driver.pasteText(f.next,{expectedDraft:'',text:f.next.text,editorToken:observed.editorToken,activityRevision:observed.activityRevision},{canInput:()=>true}):await f.driver.submit(f.next,{expectedDraft:f.next.text,editorToken:observed.editorToken,activityRevision:observed.activityRevision},{canSubmit:()=>true});
    assert.deepEqual(result,{performed:false,attempted:false,reason:'UI_QT_HEADER_CHANGED'},boundary+' '+changed);
    assert.equal(f.actions.slice(before).some(a=>['paste','submitTextEnter'].includes(a.action)),false,boundary+' '+changed);assert.equal(f.driver.textFocusLease,null);
  }
});

test('UIA conversation fingerprints reject unknown fields, wrong scope, identity claims and invalid text counts before body input',async t=>{
  for(const patch of [{extra:true},{version:2},{scope:'other'},{targetVerified:true},{sha256:'x'},{headerRuntimeIdSha256:'x'},{titleRuntimeIdSha256:'x'},{textNodeCount:0},{textNodeCount:5}]){
    const f=await completedFastNavigationFixture(t);assert.equal((await f.driver.prepare(f.next,f.plan)).ready,true);const observed=await f.driver.observe(f.next),before=f.actions.length;
    f.setFingerprint({...fastConversationFingerprint(),...patch});const result=await f.driver.pasteText(f.next,{expectedDraft:'',text:f.next.text,editorToken:observed.editorToken,activityRevision:observed.activityRevision},{canInput:()=>true});
    assert.equal(result.performed,false);assert.equal(result.reason,'UI_QT_CONTROLS_UNVERIFIED');assert.equal(f.actions.slice(before).some(a=>a.action==='paste'),false);
  }
});

test('UIA semantic editor focus failure cannot retry focus, search or body input and consumes the continuation checkpoint',async t=>{
  for(const kind of ['native-error','ack','missing-frame','navigation-frame','geometry','revision','regions','missing-marker','false-marker','string-marker','numeric-marker']){
    let fail=true;const f=await completedFastNavigationFixture(t,{focused:result=>{if(!fail)return;
      if(kind==='native-error')throw Object.assign(Error('refused'),{code:'QT_HUMAN_ACTIVITY_CHANGED',attempted:false});
      if(kind==='ack')result.editorFocused=false;if(kind==='missing-frame')delete result.postFocusFrame;
      if(kind==='navigation-frame')result.postFocusFrame.navigationOnly=true;if(kind==='geometry')result.postFocusFrame.binding.captureRect.left++;
      if(kind==='revision')result.postFocusFrame.revision++;if(kind==='regions')result.postFocusFrame.regions.reverse();
      if(kind==='missing-marker')delete result.postFocusFrame.uiaControlFrame;if(kind==='false-marker')result.postFocusFrame.uiaControlFrame=false;
      if(kind==='string-marker')result.postFocusFrame.uiaControlFrame='true';if(kind==='numeric-marker')result.postFocusFrame.uiaControlFrame=1;
    }});let result;try{result=await f.driver.prepare(f.next,f.plan);}catch(error){result={ready:false,reason:error.code};}
    assert.equal(result.ready,false,kind);assert.equal(f.actions.filter(a=>a.action==='focusUiaEditor').length,1,kind);
    if(kind.endsWith('-marker'))assert.equal(result.reason,'UI_QT_CONTROLS_BINDING_CHANGED',kind);
    assert.equal(f.actions.some(a=>['openUiaSearch','searchEnter','paste','submitTextEnter'].includes(a.action)),false,kind);assert.equal(f.driver.textFocusLease,null);
    fail=false;f.actions.length=0;assert.equal((await f.driver.prepare(f.next,f.plan)).ready,true,kind);
    assert.equal(f.actions.some(a=>a.action==='focusUiaEditor'),false,kind);assert.equal(f.actions.filter(a=>a.action==='openUiaSearch').length,1,kind);
  }
});

test('UIA editor-owned paste accepts redraw only with both control-frame markers and retains semantic evidence until fresh submit verification',async t=>{
  for(const submitProof of ['same','changed','missing']){
    const f=await completedFastNavigationFixture(t,{focused:result=>{result.postFocusFrame.uiaControlFrame=true;}});
    assert.equal((await f.driver.prepare(f.next,f.plan)).ready,true);assert.equal(f.driver.frame.uiaControlFrame,true);
    const original=f.driver.client.request,header='d'.repeat(64);let pastes=0;
    f.driver.client.request=async(action,input)=>{const result=await original(action,input);if(action==='paste'&&input.scope==='editor'){
      pastes++;assert.equal(f.driver.frame.uiaControlFrame,true);result.postPasteFrame.uiaControlFrame=true;f.setHeader(header);
    }return result;};
    let observed=await f.driver.observe(f.next);
    assert.equal((await f.driver.pasteText(f.next,{expectedDraft:'',text:f.next.text,editorToken:observed.editorToken,activityRevision:observed.activityRevision},{canInput:()=>true})).performed,true);
    assert.equal(pastes,1);assert.equal(f.driver.current.header,f.driver.frame.regions[0].controlSha256);assert.equal(f.driver.frame.regions[0].rgbaSha256,undefined);assert.equal(f.driver.frame.uiaControlFrame,true);
    assert.deepEqual(f.driver.current.uiaConversationFingerprint,fastConversationFingerprint());assert.equal(f.driver.current.draft,f.next.text);
    if(submitProof!=='same')f.setFingerprint(submitProof==='missing'?undefined:{...fastConversationFingerprint(),sha256:'f'.repeat(64)});
    observed=await f.driver.observe(f.next);const result=await f.driver.submit(f.next,{expectedDraft:f.next.text,editorToken:observed.editorToken,activityRevision:observed.activityRevision},{canSubmit:()=>true});
    if(submitProof==='same'){assert.equal(result.performed,true);assert.equal(f.actions.filter(a=>a.action==='submitTextEnter').length,1);}
    else{assert.deepEqual(result,{performed:false,attempted:false,reason:'UI_QT_HEADER_CHANGED'});assert.equal(f.actions.some(a=>a.action==='submitTextEnter'),false);}
    assert.deepEqual(f.checks,['navigation-continuation','text-input','text-submit']);assert.equal(f.driver.textFocusLease,null);
  }
});

test('post-paste redraw acceptance requires exact true markers, explicit UIA navigation and valid semantic evidence without weakening frame binding',async t=>{
  for(const kind of ['before-missing','before-false','before-string','after-missing','after-false','after-string','no-semantic','invalid-semantic','pixel-policy','pid','epoch','revision','position','idle']){
    const f=await completedFastNavigationFixture(t);assert.equal((await f.driver.prepare(f.next,f.plan)).ready,true);
    const before=structuredClone(f.driver.frame),after=structuredClone(f.driver.frame);before.uiaControlFrame=after.uiaControlFrame=true;
    after.regions[0].controlSha256='d'.repeat(64);let conversationFingerprint=fastConversationFingerprint();
    if(kind==='before-missing')delete before.uiaControlFrame;if(kind==='before-false')before.uiaControlFrame=false;if(kind==='before-string')before.uiaControlFrame='true';
    if(kind==='after-missing')delete after.uiaControlFrame;if(kind==='after-false')after.uiaControlFrame=false;if(kind==='after-string')after.uiaControlFrame='true';
    if(kind==='no-semantic')conversationFingerprint=undefined;if(kind==='invalid-semantic')conversationFingerprint.targetVerified=true;if(kind==='pixel-policy')f.driver.navigationPolicy='pixels-v1';
    if(kind==='pid')after.binding.pid++;if(kind==='epoch')after.epoch='3'.repeat(32);if(kind==='revision')after.revision++;if(kind==='position')after.binding.captureRect.left++;if(kind==='idle')after.idleMs=0;
    const frame=f.driver.frame,actions=f.actions.length;
    assert.throws(()=>f.driver.acceptPostPasteFrame(after,before,['header','editor'],{conversationFingerprint}),error=>/^(UI_QT_PASTE_UNVERIFIED|UI_QT_HUMAN_ACTIVITY_CHANGED|UI_QT_NATIVE_UPDATE_REQUIRED)$/.test(error.code),kind);
    assert.equal(f.driver.frame,frame,kind);assert.equal(f.actions.length,actions,kind);
  }
});

test('an accepted paste with changed header and missing post-paste control-frame evidence remains uncertain and cannot submit or retry',async t=>{
  for(const missing of ['after']){
    const f=await completedFastNavigationFixture(t,{focused:result=>{if(missing!=='before')result.postFocusFrame.uiaControlFrame=true;}});
    assert.equal((await f.driver.prepare(f.next,f.plan)).ready,true);const request=f.driver.client.request;
    f.driver.client.request=async(action,input)=>{const result=await request(action,input);if(action==='paste'&&input.scope==='editor'){
      if(missing==='after')delete result.postPasteFrame.uiaControlFrame;else result.postPasteFrame.uiaControlFrame=true;f.setHeader('d'.repeat(64));
    }return result;};
    const observed=await f.driver.observe(f.next),guard={expectedDraft:'',text:f.next.text,editorToken:observed.editorToken,activityRevision:observed.activityRevision};
    await assert.rejects(f.driver.pasteText(f.next,guard,{canInput:()=>true}),{code:'UI_QT_PASTE_UNVERIFIED'});
    assert.equal(f.driver.current,null);assert.equal(f.actions.filter(a=>a.action==='paste'&&a.scope==='editor').length,1);
    assert.equal((await f.driver.pasteText(f.next,guard,{canInput:()=>true})).attempted,false);
    assert.equal((await f.driver.submit(f.next,guard,{canSubmit:()=>true})).attempted,false);assert.equal(f.actions.some(a=>a.action==='submitTextEnter'),false);
    assert.equal(f.actions.filter(a=>a.action==='paste'&&a.scope==='editor').length,1);
  }
});
