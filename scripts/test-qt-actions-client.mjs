import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { QtActionsClient } from './qt-visual-driver.mjs';

const rectangle=(left,top,right,bottom)=>({left,top,right,bottom});
test('image clipboard failures retain bounded metadata but discard payloads and malformed traces',async t=>{
  const valid={version:1,stage:'restore',format:8,operationFailure:'DRAFT_CLIPBOARD_CHANGED',cleanupFailure:null,states:[{stage:'closed',sequence:4257,ownerMatched:true,formats:null}]};
  const variants=[valid,{...valid,text:'private clipboard'}, {...valid,states:[{...valid.states[0],formats:[13,'private']}]}, {...valid,states:Array(11).fill(valid.states[0])}];
  for(let i=0;i<variants.length;i++){
    const f=fixture(t,{onStop:({request,packet,exit})=>{packet({id:request.id,ok:true,result:{stopped:true}});exit();}});
    const operation=f.client.request('pasteUiaImage',{}).catch(error=>error);
    f.packet({id:f.writes.at(-1).id,ok:false,error:{code:'DRAFT_CLIPBOARD_CHANGED',attempted:false,imageClipboard:variants[i]}});
    const error=await operation;assert.equal(error.attempted,false);assert.deepEqual(error.imageClipboard,i===0?valid:undefined);
    // Diagnostic metadata alone cannot confirm that the helper restored the clipboard.
    await assert.rejects(f.client.close(),{code:'UI_QT_CLEANUP_UNCONFIRMED'});
  }
});
function fixture(t,{onStop,closeTimeoutMs=200,enableInput=true}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-qt-client-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'state/ui-host'),{recursive:true});
  fs.writeFileSync(path.join(root,'state/ui-host/WechatQtActions.exe'),'fake helper');
  const executable=path.join(root,'Weixin.exe');fs.writeFileSync(executable,'fake app');
  const config={version:1,backend:'qt-visual',account:'wxid_self',accountRef:'a'.repeat(64),accountAlias:'self_alias',executable,executableVersion:'4.1.15.56',executableSha256:crypto.createHash('sha256').update('fake app').digest('hex'),hwnd:'100',idleMs:1000,ocrBackend:'rapidocr',layout:{width:800,height:600,dpi:96,emptyEditorSha256:'b'.repeat(64),
    header:rectangle(300,20,600,60),search:rectangle(80,20,260,60),firstResult:rectangle(80,80,260,120),profileOpen:rectangle(720,20,760,60),profileAlias:rectangle(300,100,600,150),profileClose:rectangle(700,80,730,110),selfOpen:rectangle(10,20,50,60),selfAlias:rectangle(60,100,300,150),selfClose:rectangle(330,80,350,100),editor:rectangle(300,450,780,550),send:rectangle(700,560,780,590)}};
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
  const writes=[];let killed=0;
  const packet=value=>child.stdout.emit('data',Buffer.from(JSON.stringify(value)+'\n'));
  const exit=(code=0,signal=null)=>{child.emit('exit',code,signal);child.emit('close',code,signal);};
  child.kill=()=>{killed++;queueMicrotask(()=>exit(null,'SIGTERM'));};
  child.stdin.write=line=>{const request=JSON.parse(line);writes.push(request);if(request.action==='stop')queueMicrotask(()=>onStop?.({request,writes,packet,exit}));return true;};
  const client=new QtActionsClient({root,config,enableInput,spawnImpl:()=>child,closeTimeoutMs});
  return{client,child,writes,packet,exit,killed:()=>killed};
}

test('pointer parking is an input action and is unavailable on a read-only client',async t=>{
  const f=fixture(t,{enableInput:false});await assert.rejects(f.client.request('movePointer',{rect:rectangle(400,8,500,22)}),{code:'UI_QT_INPUT_DISABLED',attempted:false});assert.equal(f.writes.length,0);
});

const backgroundTextActions=['prepareUiaBackgroundText','writeUiaBackgroundText','submitUiaBackgroundText','releaseUiaBackgroundText'];
test('background failure progress preserves only the native bounded phase metadata and never grants retry authority',async t=>{
  const f=fixture(t,{onStop:({request,packet,exit})=>{packet({id:request.id,ok:true,result:{stopped:true}});exit();}});
  const phases=['prepared','write-preflight','characters','value-confirmation','written','submit-preflight','submit-messages','submit-consumption','submit-consumed'];
  for(let index=0;index<phases.length;index++){
    const action=backgroundTextActions[index%backgroundTextActions.length],value={version:1,transport:'window-message-background-v1',phase:phases[index],editorClickAttempted:false,retainedEditorRoute:true,charactersPosted:index===8?16000:index,mouseMessagesPosted:index%4,writeStarted:index>0,submitStarted:index>4,originalForegroundIsWechat:false,currentForegroundIsWechat:index===8,retryAllowed:false};
    const operation=f.client.request(action,{}).catch(error=>error),attempted=index%2===0?false:true;
    f.packet({id:f.writes.at(-1).id,ok:false,error:{code:'QT_BG_FOREGROUND_CHANGED',attempted,backgroundProgress:value}});
    const error=await operation;assert.equal(error.code,'QT_BG_FOREGROUND_CHANGED');assert.deepEqual(error.backgroundProgress,value);assert.equal(error.attempted,attempted===false?false:undefined);assert.equal(error.readOnly,undefined);assert.equal(error.inputSent,undefined);assert.equal(error.retryAllowed,undefined);
  }
  assert.equal(f.writes.length,phases.length);await f.client.close();
});

test('background failure progress drops unknown fields, invalid shapes and metadata on unrelated commands',async t=>{
  const valid={version:1,transport:'window-message-background-v1',phase:'characters',editorClickAttempted:false,retainedEditorRoute:true,charactersPosted:7,mouseMessagesPosted:0,writeStarted:true,submitStarted:false,originalForegroundIsWechat:false,currentForegroundIsWechat:false,retryAllowed:false};
  const patches=[{text:'private body'},{target:'private target'},{version:2},{transport:'window-message-v1'},{phase:'private stage'},{editorClickAttempted:true},{editorClickAttempted:undefined},{retryAllowed:true},{retainedEditorRoute:1},{writeStarted:0},{submitStarted:'false'},{originalForegroundIsWechat:undefined},{currentForegroundIsWechat:1},{charactersPosted:-1},{charactersPosted:16001},{charactersPosted:1.5},{charactersPosted:'7'},{mouseMessagesPosted:-1},{mouseMessagesPosted:4},{mouseMessagesPosted:0.5}];
  const f=fixture(t,{onStop:({request,packet,exit})=>{packet({id:request.id,ok:true,result:{stopped:true}});exit();}});
  for(const value of [...patches.map(patch=>({...valid,...patch})),null,[],{}]){
    const operation=f.client.request('writeUiaBackgroundText',{}).catch(error=>error);f.packet({id:f.writes.at(-1).id,ok:false,error:{code:'QT_BG_FOREGROUND_CHANGED',attempted:false,backgroundProgress:value}});
    const error=await operation;assert.equal(error.backgroundProgress,undefined);assert.equal(error.attempted,false);assert.equal(error.code,'QT_BG_FOREGROUND_CHANGED');assert.equal(JSON.stringify(error).includes('private'),false);
  }
  for(const action of ['click','inspectLayout']){
    const operation=f.client.request(action,{}).catch(error=>error);f.packet({id:f.writes.at(-1).id,ok:false,error:{code:'QT_BG_FOREGROUND_CHANGED',backgroundProgress:valid}});const error=await operation;assert.equal(error.backgroundProgress,undefined);assert.equal(error.attempted,undefined);
  }
  assert.equal(f.writes.length,patches.length+5);await f.client.close();
});
test('every background text endpoint requires an input-enabled real client before starting its host',async t=>{
  const f=fixture(t,{enableInput:false});
  for(const action of backgroundTextActions)await assert.rejects(f.client.request(action,{backgroundLeaseId:'a'.repeat(32)}),{code:'UI_QT_INPUT_DISABLED',attempted:false});
  assert.equal(f.client.child,null);assert.deepEqual(f.writes,[]);
});

test('background text endpoints preserve their exact requests and acknowledgments through the real JSON pipe',async t=>{
  const f=fixture(t,{onStop:({request,packet,exit})=>{packet({id:request.id,ok:true,result:{stopped:true}});exit();}});
  const backgroundLeaseId='a'.repeat(32),stepBinding={version:1,deliveryId:'b'.repeat(64),accountSha256:'c'.repeat(64),targetSha256:'d'.repeat(64)},conversationFingerprint={version:1,scope:'chat-title-text-v1',sha256:'e'.repeat(64),headerRuntimeIdSha256:'f'.repeat(64),titleRuntimeIdSha256:'1'.repeat(64),textNodeCount:1,targetVerified:false};
  const checkpoint={epoch:'2'.repeat(32),revision:7,binding:{hwnd:'100',pid:42,threadId:7,processCreatedFileTimeUtc:'12345',dpi:96,clientRect:rectangle(0,0,800,600),captureRect:rectangle(10,10,810,610)}};
  const frame={...checkpoint,token:'3'.repeat(32),binding:{...checkpoint.binding,foreground:false},backgroundLeaseId,observationKind:'uia-background-metadata-v1',pixelsRead:false,inputTransport:'window-message-background-v1',editorState:'empty',conversationFingerprint,regions:[]};
  const proof={version:1,id:'4'.repeat(32),textSha256:crypto.createHash('sha256').update('自有测试词').digest('hex')};
  const common={backgroundLeaseId,token:frame.token,epoch:frame.epoch,revision:7,idleMs:1000,stepBinding};
  const entries=[
    ['prepareUiaBackgroundText',{idleMs:1000,stepBinding,conversationFingerprint,checkpoint},{ready:true,reason:null,readOnly:true,inputSent:false,attempted:false,focusChanged:false,clipboardAccessed:false,backgroundLeaseId,frame}],
    ['writeUiaBackgroundText',{...common,text:'自有测试词',expectedText:'自有测试词'},{performed:true,attempted:true,textTransport:'window-message-background-v1',valueConfirmed:true,clipboardAccessed:false,intendedText:'自有测试词',readbackPerformed:false,interrupted:false,postPasteFrame:{...frame,editorState:'own-text'},textEnterProof:proof}],
    ['submitUiaBackgroundText',{...common,textEnterProofId:proof.id,textSha256:proof.textSha256},{performed:true,attempted:true,inputQueued:true,submissionConfirmed:false,messagesPosted:3,inputTransport:'window-message-background-v1',foregroundChanged:false,clipboardAccessed:false}],
    ['releaseUiaBackgroundText',{backgroundLeaseId},{released:true,backgroundLeaseId,inputSent:false,focusChanged:false}],
  ];
  for(const [action,values,result] of entries){
    const operation=f.client.request(action,values),written=f.writes.at(-1);assert.deepEqual(written,{...values,id:written.id,action});
    f.packet({id:written.id,ok:true,result});assert.deepEqual(await operation,result);
  }
  await f.client.close();assert.equal(f.killed(),0);assert.deepEqual(f.writes.map(x=>x.action),[...backgroundTextActions,'stop']);
});

test('background text transport preserves read-only declines, rejects malformed packets and never retries a write',async t=>{
  const f=fixture(t,{onStop:({request,packet,exit})=>{packet({id:request.id,ok:true,result:{stopped:true}});exit();}});
  const declined={ready:false,reason:'QT_BG_EDITOR_NOT_EMPTY',readOnly:true,inputSent:false,attempted:false,focusChanged:false,clipboardAccessed:false};
  const preparation=f.client.request('prepareUiaBackgroundText',{});f.packet({id:f.writes.at(-1).id,ok:true,result:declined});assert.deepEqual(await preparation,declined);
  for(const action of backgroundTextActions)await assert.rejects(f.client.request(action,[]),{code:'UI_QT_REQUEST_INVALID'});
  assert.equal(f.writes.length,1);
  const writing=f.client.request('writeUiaBackgroundText',{text:'自有测试词'});const rejected=assert.rejects(writing,{code:'UI_QT_PROTOCOL_INVALID'});
  f.packet({id:f.writes.at(-1).id,ok:true,result:null});await rejected;await f.client.close();assert.equal(f.writes.filter(x=>x.action==='writeUiaBackgroundText').length,1);assert.equal(f.killed(),0);
});
test('dedicated Return actions require input permission and preserve exact proof packets through the real client transport',async t=>{
  const readonly=fixture(t,{enableInput:false});
  for(const action of ['searchEnter','submitTextEnter','resumeTextEnterProof'])await assert.rejects(readonly.client.request(action,{}),{code:'UI_QT_INPUT_DISABLED',attempted:false});
  assert.equal(readonly.writes.length,0);
  const f=fixture(t,{onStop:({request,packet,exit})=>{packet({id:request.id,ok:true,result:{stopped:true}});exit();}});
  for(const action of ['searchEnter','submitTextEnter','resumeTextEnterProof']){
    const values={token:'a'.repeat(32),epoch:'b'.repeat(32),revision:7,idleMs:1000,...(action==='searchEnter'?{searchEnterProofId:'c'.repeat(32),querySha256:'d'.repeat(64)}:{textEnterProofId:'e'.repeat(32),textSha256:'f'.repeat(64),stepBinding:{version:1,deliveryId:'1'.repeat(64),accountSha256:'2'.repeat(64),targetSha256:'3'.repeat(64)},headerRect:rectangle(300,20,600,60),editorRect:rectangle(300,450,780,550)})};
    const request=f.client.request(action,values),written=f.writes.at(-1);assert.deepEqual(written,{...values,id:written.id,action});
    f.packet({id:written.id,ok:true,result:{performed:true,attempted:true,revision:7,[action==='searchEnter'?'searchAccepted':'submittedViaEnter']:true}});
    assert.equal((await request).performed,true);
  }
  await f.client.close();
});

test('OCR grapheme typing requires input permission before starting the native host',async t=>{
  const f=fixture(t,{enableInput:false});
  await assert.rejects(f.client.request('typeText',{text:'好',expectedText:'好'}),{code:'UI_QT_INPUT_DISABLED',attempted:false});
  assert.equal(f.client.child,null);assert.deepEqual(f.writes,[]);
});

test('OCR typed text transports exact Unicode prefixes and native continuation proofs without clipboard claims',async t=>{
  const f=fixture(t,{onStop:({request,packet,exit})=>{packet({id:request.id,ok:true,result:{stopped:true}});exit();}});
  const stepBinding={version:1,deliveryId:'a'.repeat(64),accountSha256:'b'.repeat(64),targetSha256:'c'.repeat(64)};
  const common={token:'1'.repeat(32),epoch:'2'.repeat(32),revision:7,idleMs:1000,stepBinding,headerRect:rectangle(300,20,600,60),editorRect:rectangle(300,450,780,550)};
  let expectedText='',priorId;
  for(const [index,text]of ['你','\n','👩‍💻'].entries()){
    expectedText+=text;
    const values={...common,text,expectedText,...(priorId?{textEnterProofId:priorId}:{}),...(text==='\n'?{newlineKey:'Shift+Enter'}:{})};
    const operation=f.client.request('typeText',values),written=f.writes.at(-1);assert.deepEqual(written,{...values,id:written.id,action:'typeText'});
    priorId=String(index+3).repeat(32);
    const result={performed:true,attempted:true,revision:7,typeApplied:true,readbackPerformed:false,intendedText:expectedText,clipboardAccessed:false,interrupted:index===2,
      textEnterProof:{version:1,id:priorId,textSha256:crypto.createHash('sha256').update(expectedText).digest('hex')},
      ...(index===2?{}:{postPasteFrame:{token:'4'.repeat(32),epoch:common.epoch,revision:7,regions:[]}})};
    f.packet({id:written.id,ok:true,result});assert.deepEqual(await operation,result);
  }
  assert.equal(f.client.cleanupUnconfirmed,false);assert.deepEqual(f.writes.map(row=>row.action),['typeText','typeText','typeText']);
  await f.client.close();assert.equal(f.killed(),0);
});

test('OCR native typing refusal or uncertain input is returned once and never retried or converted to paste',async t=>{
  for(const [code,attempted]of [['QT_TYPED_TEXT_PREFIX_CHANGED',false],['QT_HUMAN_ACTIVITY_CHANGED',false],['DRAFT_INPUT_INCOMPLETE',true]]){
    const f=fixture(t,{onStop:({request,packet,exit})=>{packet({id:request.id,ok:true,result:{stopped:true}});exit();}});
    const operation=f.client.request('typeText',{text:'好',expectedText:'你好'}).catch(error=>error);
    f.packet({id:f.writes.at(-1).id,ok:false,error:{code,attempted}});const error=await operation;
    assert.equal(error.code,code);assert.equal(error.attempted,attempted===false?false:undefined);assert.equal(f.client.cleanupUnconfirmed,false);
    await f.client.close();assert.deepEqual(f.writes.map(row=>row.action),['typeText','stop']);assert.equal(f.killed(),0);
  }
  const f=fixture(t,{onStop:({request,packet,exit})=>{packet({id:request.id,ok:true,result:{stopped:true}});exit();}});
  const operation=f.client.request('typeText',{text:'好',expectedText:'好'}),rejected=assert.rejects(operation,{code:'UI_QT_PROTOCOL_INVALID'});
  f.packet({id:f.writes.at(-1).id,ok:true,result:null});await rejected;await f.client.close();assert.deepEqual(f.writes.map(row=>row.action),['typeText','stop']);
});

test('layout inspection permits read-only clients but focus segment actions still require input permission',async t=>{
  const f=fixture(t,{enableInput:false,onStop:({request,packet,exit})=>{packet({id:request.id,ok:true,result:{stopped:true}});exit();}});
  for(const action of ['inspectLayout','captureLayout','inspectUiaFocusGeometry']){
    const operation=f.client.request(action,{image:true});
    f.packet({id:f.writes.at(-1).id,ok:true,result:{readOnly:true,focusChanged:false,authorizationGranted:false}});
    const result=await operation;assert.equal(result.authorizationGranted,false);assert.equal(result.readOnly,true);
  }
  const before=f.writes.length;
  for(const action of ['parkFocusHandoff','resumeFocusHandoff'])await assert.rejects(f.client.request(action),{code:'UI_QT_INPUT_DISABLED',attempted:false});
  assert.equal(f.writes.length,before);await f.client.close();
});

test('UIA locator warmup uses the read-only real client pipe and conveys no input authority',async t=>{
  const f=fixture(t,{enableInput:false,onStop:({request,packet,exit})=>{packet({id:request.id,ok:true,result:{stopped:true}});exit();}});
  const expectedBinding={hwnd:'100',pid:42,processCreatedFileTimeUtc:'12345',dpi:96,clientRect:rectangle(0,0,800,600),captureRect:rectangle(10,10,810,610)};
  const operation=f.client.request('warmUiaLocators',{expectedBinding}),written=f.writes.at(-1);assert.deepEqual(written,{expectedBinding,id:written.id,action:'warmUiaLocators'});
  const acknowledgment={version:1,warmed:true,readOnly:true,inputSent:false,focusChanged:false,clipboardAccessed:false,authorizationGranted:false,foregroundUnchanged:true,inputTickUnchanged:true,cursorUnchanged:true,binding:{...expectedBinding,foreground:false},roles:['header','editor','send']};
  f.packet({id:written.id,ok:true,result:acknowledgment});assert.deepEqual(await operation,acknowledgment);assert.equal(Object.hasOwn(written,'token'),false);assert.equal(Object.hasOwn(acknowledgment,'token'),false);
  await assert.rejects(f.client.request('warmUiaLocators',[]),{code:'UI_QT_REQUEST_INVALID'});assert.equal(f.writes.length,1);await f.client.close();
});

test('close waits for the active clipboard rollback and drained response without killing',async t=>{
  let restored=false;
  const f=fixture(t,{onStop:({request,writes,packet,exit})=>setTimeout(()=>{
    restored=true;
    packet({id:writes[0].id,ok:false,error:{code:'QT_STOPPING',attempted:true,clipboardRestored:true}});
    packet({id:request.id,ok:true,result:{stopped:true}});exit();
  },30)});
  const operation=f.client.request('readDraft').catch(error=>error);
  const closing=f.client.close();assert.equal(f.client.close(),closing);assert.equal(restored,false);
  assert.deepEqual(await closing,{processStopped:true});assert.equal(restored,true);
  assert.equal((await operation).clipboardRestored,true);assert.equal(f.killed(),0);
  assert.throws(()=>f.client.request('capture'),{code:'UI_QT_CLOSED'});
});

test('diagnostic copy also requires restored clipboard before close can confirm cleanup',async t=>{
  const f=fixture(t,{onStop:({request,writes,packet,exit})=>{
    packet({id:writes[0].id,ok:false,error:{code:'DRAFT_CLIPBOARD_RESTORE_UNCONFIRMED',attempted:true,clipboardRestored:false}});
    packet({id:request.id,ok:true,result:{stopped:true}});exit();
  }});
  const operation=f.client.request('diagnoseDraftStructure').catch(error=>error);
  await assert.rejects(f.client.close(),{code:'UI_QT_CLEANUP_UNCONFIRMED'});
  assert.equal((await operation).clipboardRestored,false);assert.equal(f.killed(),0);
});

test('a definite refusal before copy is safe to close even without restore metadata',async t=>{
  const f=fixture(t,{onStop:({request,writes,packet,exit})=>{
    packet({id:writes[0].id,ok:false,error:{code:'QT_PIXELS_CHANGED',attempted:false}});
    packet({id:request.id,ok:true,result:{stopped:true}});exit();
  }});
  const operation=f.client.request('readDraft').catch(error=>error);
  assert.deepEqual(await f.client.close(),{processStopped:true});assert.equal((await operation).attempted,false);
});

test('paste clipboard failure before any keystroke still requires rollback evidence',async t=>{
  const f=fixture(t,{onStop:({request,writes,packet,exit})=>{
    packet({id:writes[0].id,ok:false,error:{code:'DRAFT_CLIPBOARD_RESTORE_FAILED',attempted:false,clipboardRestored:false}});
    packet({id:request.id,ok:true,result:{stopped:true}});exit();
  }});
  const operation=f.client.request('paste').catch(error=>error);
  await assert.rejects(f.client.close(),{code:'UI_QT_CLEANUP_UNCONFIRMED'});
  assert.equal((await operation).attempted,false);assert.equal(f.killed(),0);
});
test('paste refusal with explicit original-clipboard evidence safely closes',async t=>{
  const f=fixture(t,{onStop:({request,writes,packet,exit})=>{
    packet({id:writes[0].id,ok:false,error:{code:'QT_USER_ACTIVE',attempted:false,clipboardRestored:true}});
    packet({id:request.id,ok:true,result:{stopped:true}});exit();
  }});
  const operation=f.client.request('paste').catch(error=>error);
  assert.deepEqual(await f.client.close(),{processStopped:true});assert.equal((await operation).clipboardRestored,true);
});

test('forced close timeout reports unknown cleanup and rejects pending copy',async t=>{
  const f=fixture(t,{closeTimeoutMs:20});const operation=f.client.request('readDraft').catch(error=>error);
  await assert.rejects(f.client.close(),{code:'UI_QT_CLEANUP_UNCONFIRMED'});
  assert.equal((await operation).code,'UI_QT_CLEANUP_UNCONFIRMED');assert.equal(f.killed(),1);
  assert.deepEqual(f.writes.map(request=>request.action),['readDraft','stop']);
});

test('focus refusal preserves only bounded anonymous confirmation diagnostics and never retries',async t=>{
  const f=fixture(t,{onStop:({request,packet,exit})=>{packet({id:request.id,ok:true,result:{stopped:true}});exit();}});
  const operation=f.client.request('beginFocusHandoff').catch(error=>error);
  const diagnostic={attempted:true,accepted:true,confirmed:false,elapsedMs:500,reason:'timeout'};
  f.packet({id:f.writes[0].id,ok:false,error:{code:'QT_FOCUS_ACQUIRE_UNCONFIRMED',attempted:false,focusConfirmation:{...diagnostic,privateTitle:'never expose',hwnd:'98765'}}});
  const error=await operation;assert.equal(error.code,'QT_FOCUS_ACQUIRE_UNCONFIRMED');assert.equal(error.attempted,false);assert.deepEqual(error.focusConfirmation,diagnostic);assert.equal(JSON.stringify(error).includes('never expose'),false);
  assert.equal(f.writes.length,1);await f.client.close();assert.equal(f.writes.filter(row=>row.action==='beginFocusHandoff').length,1);
});

test('invalid focus diagnostic is omitted without treating an unconfirmed switch as success',async t=>{
  const f=fixture(t,{onStop:({request,packet,exit})=>{packet({id:request.id,ok:true,result:{stopped:true}});exit();}});
  const operation=f.client.request('beginFocusHandoff').catch(error=>error);
  f.packet({id:f.writes[0].id,ok:false,error:{code:'QT_FOCUS_ACQUIRE_UNCONFIRMED',attempted:false,focusConfirmation:{attempted:true,accepted:'yes',confirmed:false,elapsedMs:Infinity,reason:'private arbitrary text'}}});
  const error=await operation;assert.equal(error.code,'QT_FOCUS_ACQUIRE_UNCONFIRMED');assert.equal(error.focusConfirmation,undefined);await f.client.close();
});

test('focus diagnostics distinguish a denied API from an already-target observation without exposing extra values',async t=>{
  const f=fixture(t,{onStop:({request,packet,exit})=>{packet({id:request.id,ok:true,result:{stopped:true}});exit();}});
  const operation=f.client.request('beginFocusHandoff').catch(error=>error);
  const activation={currentThreadId:1,sourceThreadId:2,targetThreadId:3,attachError:0,detachError:0,foregroundLastError:0,attachmentNeeded:false,attached:false,detached:false,foregroundLastErrorInformational:true,foregroundAfter:'target',foregroundRequestAccepted:false,alreadyTargetWithoutClick:true,calibratedClickAttempted:false,calibratedClickApplied:false};
  const diagnostic={attempted:true,accepted:true,confirmed:false,elapsedMs:15,reason:'guard-failed',activation};
  f.packet({id:f.writes[0].id,ok:false,error:{code:'DRAFT_HUMAN_ACTIVITY_CHANGED',attempted:false,focusConfirmation:{...diagnostic,activation:{...activation,privateTitle:'never expose',privateHwnd:'98765',returnCaptionApplied:'not a boolean'}}}});
  const error=await operation;assert.equal(error.code,'DRAFT_HUMAN_ACTIVITY_CHANGED');assert.deepEqual(error.focusConfirmation,diagnostic);assert.equal(JSON.stringify(error).includes('never expose'),false);assert.equal(JSON.stringify(error).includes('98765'),false);assert.equal(f.writes.length,1);await f.client.close();
});

test('target visibility failure keeps bounded anonymous readiness evidence and never retries a raise',async t=>{
  const base={version:1,raiseAttempted:true,requestAccepted:false,confirmed:false,initialBlockingCount:2,lastBlockingCount:2,elapsedMs:250,reason:'timeout'};
  for(const value of [base,{...base,privateWindowTitle:'never expose'},{...base,requestAccepted:'yes'},{...base,confirmed:true}]){
    const f=fixture(t,{onStop:({request,packet,exit})=>{packet({id:request.id,ok:true,result:{stopped:true}});exit();}});
    const operation=f.client.request('beginFocusHandoff').catch(error=>error);
    f.packet({id:f.writes[0].id,ok:false,error:{code:'QT_WINDOW_OBSCURED',attempted:false,focusVisibility:value,foregroundInterval:{phase:'preparation',durationMs:280,includesContactNavigation:false,complete:false}}});
    const error=await operation;assert.equal(error.code,'QT_WINDOW_OBSCURED');assert.deepEqual(error.focusVisibility,value===base?base:undefined);assert.equal(error.foregroundInterval.complete,false);assert.equal(JSON.stringify(error).includes('never expose'),false);assert.equal(f.writes.length,1);await f.client.close();assert.equal(f.writes.filter(row=>row.action==='beginFocusHandoff').length,1);
  }
});

test('focus-return refusal keeps only anonymous condition outcomes including unobserved checks',async t=>{
  const base={version:1,reason:'identity-check-failed',restored:null,skipped:false,foregroundOwnedByWechat:true,identitiesUnchanged:null,activityUnchanged:true,keysReleased:null,parkRevisionUnchanged:null};
  for(const value of [base,{...base,reason:'keys-held',restored:false,skipped:true,identitiesUnchanged:true,keysReleased:false},{...base,privateTitle:'never expose'},{...base,keysReleased:'yes'},{...base,reason:'private arbitrary text'}]){
    const f=fixture(t,{onStop:({request,packet,exit})=>{packet({id:request.id,ok:true,result:{stopped:true}});exit();}});
    const operation=f.client.request('parkFocusHandoff').catch(error=>error);
    f.packet({id:f.writes[0].id,ok:false,error:{code:'QT_FOCUS_RETURN_UNCONFIRMED',attempted:false,focusRestoreOutcome:value}});
    const error=await operation;assert.equal(error.code,'QT_FOCUS_RETURN_UNCONFIRMED');assert.equal(error.attempted,false);
    assert.deepEqual(error.focusRestoreOutcome,[base.reason,'keys-held'].includes(value.reason)&&Object.keys(value).length===9&&value.keysReleased!=='yes'?value:undefined);
    assert.equal(JSON.stringify(error).includes('never expose'),false);assert.equal(JSON.stringify(error).includes('private arbitrary'),false);
    assert.equal(f.writes.length,1);await f.client.close();assert.equal(f.writes.filter(row=>row.action==='parkFocusHandoff').length,1);
  }
});

test('pixel mismatch diagnostics expose only bounded stage and anchor index and never change refusal or retry',async t=>{
  for(const diagnostic of [{stage:'guard',anchorIndex:1},{stage:'capture',anchorIndex:8},{stage:'guard',anchorIndex:1,hash:'secret'},{stage:'private text',anchorIndex:0}]){
    const f=fixture(t,{onStop:({request,packet,exit})=>{packet({id:request.id,ok:true,result:{stopped:true}});exit();}});
    const operation=f.client.request('click').catch(error=>error);f.packet({id:f.writes[0].id,ok:false,error:{code:'QT_PIXELS_CHANGED',attempted:false,pixelMismatch:diagnostic}});
    const error=await operation;assert.equal(error.code,'QT_PIXELS_CHANGED');assert.equal(error.attempted,false);assert.deepEqual(error.pixelMismatch,Object.keys(diagnostic).length===2&&diagnostic.stage==='guard'?diagnostic:undefined);
    assert.equal(JSON.stringify(error).includes('secret'),false);assert.equal(f.writes.length,1);await f.client.close();
  }
});

test('popup binding refusal preserves bounded anonymous failure observations without retrying paste',async t=>{
  const sample={version:1,stage:'active',pasteStage:'paste-settle',kind:'search',inputAttempted:true,readOnly:true,authorizationGranted:false,observationAfterFailure:true,observed:true,revisionUnchangedBefore:true,revisionUnchangedAfter:true,foregroundIsRoot:true,foregroundIsPopup:false,enumerationComplete:true,elapsedMs:8,
    boundWindowRectInRoot:rectangle(70,66,330,466),boundClientRect:rectangle(0,0,260,400),boundClientRectInRoot:rectangle(70,66,330,466),frameWindowRectInRoot:rectangle(70,66,330,466),frameClientRect:rectangle(0,0,260,400),
    boundNow:{available:true,sameBoundWindow:true,previouslyVisible:false,visible:false,minimized:false,identityReadable:true,processMatches:true,threadMatches:true,classMatches:true,styleMatches:true,extendedStyleMatches:true,dpiMatches:true,dpi:120,ownerMatches:true,windowRectInRoot:rectangle(70,66,330,226),clientRect:rectangle(0,0,260,160),clientRectInRoot:rectangle(70,66,330,226),boundsInsideRoot:true,observedGeometryAllowed:true},visibleCandidates:[]};
  const mutate=[x=>x,x=>({...x,boundNow:{available:false,sameBoundWindow:true,previouslyVisible:false},enumerationComplete:false}),x=>({...x,title:'private title'}),x=>({...x,boundNow:{...x.boundNow,hwnd:'1234'}}),x=>({...x,visibleCandidates:[{...x.boundNow,className:'private class'}]}),x=>({...x,pasteStage:'private query'}),x=>({...x,inputAttempted:1}),x=>({...x,authorizationGranted:true}),x=>({...x,visibleCandidates:Array(9).fill(x.boundNow)}),x=>({...x,frameClientRect:{...x.frameClientRect,secret:'private'}})];
  for(let index=0;index<mutate.length;index++){
    const f=fixture(t,{onStop:({request,packet,exit})=>{packet({id:request.id,ok:true,result:{stopped:true}});exit();}}),diagnostic=mutate[index](structuredClone(sample));
    const operation=f.client.request('paste').catch(error=>error);f.packet({id:f.writes[0].id,ok:false,error:{code:'QT_POPUP_BINDING_CHANGED',attempted:true,clipboardRestored:true,popupBindingMismatch:diagnostic}});
    const error=await operation;assert.equal(error.code,'QT_POPUP_BINDING_CHANGED');assert.equal(error.clipboardRestored,true);assert.deepEqual(error.popupBindingMismatch,index<2?diagnostic:undefined);
    assert.equal(JSON.stringify(error).includes('private'),false);assert.deepEqual(f.writes.map(x=>x.action),['paste']);await f.client.close();assert.deepEqual(f.writes.map(x=>x.action),['paste','stop']);
  }
});

test('failed focus restoration carries only strict anonymous incomplete timing and never retries',async t=>{
  for(const invalid of [false,true]){
    const f=fixture(t,{onStop:({request,packet,exit})=>{packet({id:request.id,ok:true,result:{stopped:true}});exit();}});
    const operation=f.client.request('releaseFocusHandoff').catch(error=>error);
    const interval={phase:'preparation',durationMs:350,includesContactNavigation:false,complete:true};
    f.packet({id:f.writes[0].id,ok:false,error:{code:'QT_FOCUS_RETURN_UNCONFIRMED',foregroundInterval:invalid?{...interval,privateTitle:'never expose'}:interval}});
    const error=await operation;assert.equal(error.code,'QT_FOCUS_RETURN_UNCONFIRMED');
    assert.deepEqual(error.foregroundInterval,invalid?undefined:{...interval,complete:false});
    assert.equal(JSON.stringify(error).includes('never expose'),false);assert.equal(f.writes.length,1);
    await f.client.close();assert.equal(f.writes.filter(row=>row.action==='releaseFocusHandoff').length,1);
  }
});

test('missing rollback response cannot be mistaken for a successful stop',async t=>{
  const f=fixture(t,{onStop:({request,packet,exit})=>{packet({id:request.id,ok:true,result:{stopped:true}});exit();}});
  const operation=f.client.request('readDraft').catch(error=>error);
  await assert.rejects(f.client.close(),{code:'UI_QT_CLEANUP_UNCONFIRMED'});
  assert.equal((await operation).code,'UI_QT_EXITED');assert.equal(f.killed(),0);
});

test('release uses cooperative stop and confirms native process exit',async t=>{
  const f=fixture(t,{onStop:({request,packet,exit})=>{packet({id:request.id,ok:true,result:{stopped:true}});exit();}});
  const capture=f.client.request('capture');f.packet({id:f.writes[0].id,ok:true,result:{readOnly:true}});await capture;
  assert.deepEqual(await f.client.release(),{processStopped:true});assert.equal(f.killed(),0);
});

test('exit preceding the final stdout rollback packet does not prematurely fail the request',async t=>{
  const f=fixture(t,{onStop:({request,writes,packet})=>{
    f.child.emit('exit',0,null);
    packet({id:writes[0].id,ok:true,result:{clipboardRestored:true,draft:'fixture'}});
    packet({id:request.id,ok:true,result:{stopped:true}});f.child.emit('close',0,null);
  }});
  const operation=f.client.request('readDraft');assert.deepEqual(await f.client.close(),{processStopped:true});
  assert.equal((await operation).clipboardRestored,true);assert.equal(f.killed(),0);
});

test('popup inspection stays available to a read-only client after a capture ownership refusal',async t=>{
  const f=fixture(t,{enableInput:false,onStop:({request,packet,exit})=>{packet({id:request.id,ok:true,result:{stopped:true}});exit();}});
  const capture=f.client.request('capture',{surface:'owned-profile'}).catch(error=>error);
  f.packet({id:f.writes.at(-1).id,ok:false,error:{code:'QT_POPUP_NOT_OWNED',attempted:false}});
  assert.equal((await capture).code,'QT_POPUP_NOT_OWNED');
  const hitRects=[rectangle(10,20,50,60)],pending=f.client.request('inspectPopup',{hitRects});
  assert.deepEqual(f.writes.at(-1).hitRects,hitRects);
  const diagnostic={readOnly:true,inputSent:false,clipboardAccessed:false,focusChanged:false,authorizationGranted:false,stableObservation:false};
  f.packet({id:f.writes.at(-1).id,ok:true,result:diagnostic});assert.deepEqual(await pending,diagnostic);
  await assert.rejects(f.client.request('click'),{code:'UI_QT_INPUT_DISABLED'});
  assert.deepEqual(await f.client.close(),{processStopped:true});
  assert.deepEqual(f.writes.map(value=>value.action),['capture','inspectPopup','stop']);
});

test('inactive focus template inspection is explicitly available to a read-only client',async t=>{
  const f=fixture(t,{enableInput:false,onStop:({request,packet,exit})=>{packet({id:request.id,ok:true,result:{stopped:true}});exit();}});
  const values={idleMs:1000,width:800,height:600,dpi:96,rect:rectangle(350,8,450,22)};
  const pending=f.client.request('inspectFocusActivation',values);assert.equal(f.writes.at(-1).action,'inspectFocusActivation');
  const result={readOnly:true,inputSent:false,focusChanged:false,clipboardAccessed:false,stableObservations:2,rect:values.rect,rgbaSha256:'a'.repeat(64)};
  f.packet({id:f.writes.at(-1).id,ok:true,result});assert.deepEqual(await pending,result);
  await assert.rejects(f.client.request('beginFocusHandoff',values),{code:'UI_QT_INPUT_DISABLED'});await f.client.close();
  assert.deepEqual(f.writes.map(x=>x.action),['inspectFocusActivation','stop']);
});
