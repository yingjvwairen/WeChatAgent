import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {UiOneBotBackend,uiOneBotId,createImageUiDriver,createSynchronousUiConfigScope} from './ui-onebot.mjs';
import {UiImageOutbox} from './ui-image-outbox.mjs';
import {ReplyMediaCatalog} from './reply-media-catalog.mjs';
import {TargetSelectionStore} from './target-selection.mjs';
import {WechatOneBotAdapter} from '../components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js';

const hash=value=>crypto.createHash('sha256').update(value).digest('hex'),id=digit=>digit.repeat(64);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=','base64');
const plan=()=>({allowed:true,executionMode:'foreground',requiresForeground:true,requiresActivityGuard:true,textEntryMode:'paste'});
const pause=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ui-image-onebot-')),account='fixture-self',target='fixture-friend',directory=path.join(root,'state/reader-service');fs.mkdirSync(directory,{recursive:true});
  const accountRef=id('a');fs.writeFileSync(path.join(directory,'target.json'),JSON.stringify({version:1,accountRef,targetWxid:target,targetId:uiOneBotId(target),displayName:'Fixture',alias:'fixture',autoSend:false,onScreenVerified:false}));
  const selectionStore=new TargetSelectionStore({root,accountRef,resolveTargets:async names=>names.map(wechatId=>({wechatId,id:uiOneBotId(wechatId),name:'Fixture',alias:'',ambiguous:false}))});
  const scope=selectionStore.grantIncoming({account,target,eventId:'fixture-event',selectionVersion:selectionStore.get().version});
  const source=path.join(root,'fixture.png');fs.writeFileSync(source,png);const assetId=hash(png),catalog=new ReplyMediaCatalog({root});
  catalog.replace({expectedRevision:catalog.snapshot().revision,enabled:true,items:[{id:assetId,sha256:assetId,name:'问候配图',kind:'sticker',path:source,tags:['问候']}]});
  let now=1700000000000,backend;const events=[],state={allowed:true,imageConfirmed:false,textConfirmed:true,draft:'',applied:null},instances=[];
  const native={
    prepare:async job=>{events.push(job.mode==='image'?'prepare-image':'prepare-text');return{ready:true};},
    observe:async job=>{
      if(job.mode==='image'&&state.imageInactive)return{ready:false,reason:'UI_QT_PREPARATION_REQUIRED'};
      if(job.mode==='image'&&state.pauseImageOnce&&state.applied){state.pauseImageOnce=false;state.imageInactive=true;return{ready:false,reason:'QT_USER_ACTIVE'};}
      return{ready:true,account:job.account,target:job.target,foreground:true,idleMs:1000,editorToken:'fixture-editor',activityRevision:'fixture-activity',
        ...(job.mode==='image'?{appliedImageId:state.applied}:{draft:state.draft})};
    },
    canResumeImage:job=>state.resumeProof===true&&state.applied===job.id,
    resumeImage:async(_job,{canInput})=>{assert.equal(canInput(),true);events.push('resume-image');state.imageInactive=false;return{ready:true,imageResume:true};},
    typeGrapheme:()=>assert.fail('fixture uses paste'),
    pasteText:async(_job,guard)=>{assert.equal(guard.canInput(),true);events.push('paste-text');state.draft+=guard.text;return{performed:true,attempted:true};},
    submit:async(_job,guard)=>{assert.equal(guard.canSubmit(),true);events.push('submit-text');state.draft='';return{performed:true,attempted:true};},
    receipt:async job=>state.textConfirmed?{confirmed:true,receipt:{type:'wechat-database-text-v1',deliveryId:job.id,account:job.account,target:job.target,textSha256:hash(job.text),serverId:'900'}}:{confirmed:false},
    pasteImage:async(job,guard,local)=>{assert.equal(job.text,undefined);assert.equal(guard.text,undefined);assert.equal(guard.canInput,undefined);assert.equal(local.canInput(),true);events.push('paste-image');state.applied=job.id;return{performed:true,attempted:true};},
    submitImage:async(job,guard,local)=>{assert.equal(job.text,undefined);assert.equal(guard.canSubmit,undefined);assert.equal(local.canSubmit(),true);events.push('submit-image');return{performed:true,attempted:true};},
    releaseTextFocus:async()=>{events.push('release');},close:async()=>{events.push('close');},
  };
  const receipts={prepare:async()=>{events.push('baseline');return{prepared:true,submissionAllowed:true};},submitted:()=>events.push('submit-intent'),
    query:async job=>{events.push('image-receipt');return state.imageConfirmed?{confirmed:true,receipt:{type:'wechat-database-image-v1',deliveryId:job.id,account:job.account,target:job.target,
      accountDirectory:'fixture-account',sourceImageSha256:job.sourceImageSha256,nativeImageRowConfirmed:true,imageContentVerified:false,localType:3,sourceShard:id('e'),localId:'1',serverId:'901',createTime:now/1000,observedAt:now}}:{confirmed:false};}};
  const create=()=>{
    let instance;
    const imageDriver=createImageUiDriver({native,inputAllowed:()=>state.allowed,authorizeDelivery:job=>selectionStore.authorizeDelivery(job),currentPlan:plan,control:()=>instance?.outbox.control()??{paused:true},
      prepareThrough:(job,options,prepare)=>instance.outbox.prepareExternal(job,{...options,prepare})});
    const imageOutbox=new UiImageOutbox({directory:path.join(root,'image-outbox'),driver:imageDriver,receipts,authorizeScope:scope=>state.allowed&&selectionStore.authorizeReplyScope(scope),now:()=>now,
      settings:{idleMs:1000,intervalMs:0,receiptTimeoutMs:30000}});
    instance=new UiOneBotBackend({directory:path.join(root,'text-outbox'),policy:{accountWxid:account,targets:[{kind:'private',id:uiOneBotId(target),wxid:target}]},selectionStore,driver:native,
      settings:{idleMs:1000,intervalMs:0,punctuationPauseMs:0,receiptTimeoutMs:30000},now:()=>now,currentPlan:plan,imageOutbox,mediaCatalog:catalog});instances.push(instance);backend=instance;return instance;
  };
  create();t.after(async()=>{await Promise.all(instances.map(instance=>instance.shutdown()));assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^ui-image-onebot-/);fs.rmSync(root,{recursive:true,force:true});});
  const request=(delivery=id('1'),image=true)=>({action:'send_private_msg',params:{user_id:uiOneBotId(target),self_id:uiOneBotId(account),wechatagent_delivery_protocol:'durable-ui-v1',wechatagent_delivery_id:delivery,
    wechatagent_selection_scope:scope,message:[image?{type:'wechat_image',data:{id:assetId}}:{type:'text',data:{text:'fixture text'}}]}});
  const query=(delivery=id('1'))=>({action:'get_wechatagent_delivery',params:{self_id:uiOneBotId(account),kind:'private',target:uiOneBotId(target),wechatagent_delivery_protocol:'durable-ui-v1',wechatagent_delivery_id:delivery}});
  return{root,account,target,scope,assetId,source,catalog,selectionStore,native,receipts,state,events,create,request,query,advance:ms=>now+=ms,get backend(){return backend;}};
}

test('image capability lists only selected local candidate IDs and admits one typed immutable asset',async t=>{
  const f=await fixture(t),backend=f.backend;assert(backend.meta().wechatagent_capabilities.includes('native-image-output-v1'));
  const catalog=await backend.action({action:'get_sticker_list',params:{kind:'private',target:uiOneBotId(f.target)}});assert.equal(catalog.status,'ok');assert.equal(catalog.data.stickers[0].id,f.assetId);assert.equal(catalog.data.stickers[0].path,undefined);
  assert.equal((await backend.action({action:'get_sticker_list',params:{kind:'private',target:'1'}})).status,'failed');
  const admitted=await backend.action(f.request());assert.equal(admitted.data.state,'queued');assert.equal(backend.outbox.list().length,0);assert.equal(backend.imageOutbox.list().length,1);assert.equal(f.events.length,0);
  assert(f.selectionStore.authorizeDelivery({id:id('1'),account:f.account,target:f.target,text:'[IMAGE:'+f.assetId+']'}));
  await backend.tick();assert.deepEqual(f.events.filter(event=>['paste-image','submit-image','paste-text'].includes(event)),['paste-image','submit-image']);
  assert(f.events.indexOf('baseline')<f.events.indexOf('submit-intent')&&f.events.indexOf('submit-intent')<f.events.indexOf('submit-image'));
  f.state.imageConfirmed=true;await backend.tick();const result=(await backend.action(f.query())).data;
  assert.equal(result.state,'confirmed');assert.equal(result.receipt.textSha256,hash('[IMAGE:'+f.assetId+']'));assert.equal(result.receipt.evidence.type,'wechat-database-image-v1');assert.equal(result.receipt.evidence.imageContentVerified,false);
  fs.unlinkSync(f.source);assert.equal((await backend.action(f.request())).data.state,'confirmed');assert.equal(f.events.filter(event=>event==='paste-image').length,1);
});
test('adapter-to-backend image protocol confirms once with a real durable image queue fixture',async t=>{
  const f=await fixture(t),adapter=new WechatOneBotAdapter();adapter.server.emit('event',f.backend.meta());adapter.server.action=async(action,params)=>f.backend.action({action,params});
  const request={kind:'private',target:uiOneBotId(f.target),selfId:uiOneBotId(f.account),id:f.assetId,deliveryId:id('1'),selectionRequired:true,selectionScope:f.scope};
  assert.equal((await adapter.sendSticker(request)).pending,true);await f.backend.tick();assert.equal((await adapter.sendSticker(request)).pending,true);
  f.state.imageConfirmed=true;await f.backend.tick();assert.equal((await adapter.sendSticker(request)).confirmed,true);assert.equal(f.events.filter(event=>event==='submit-image').length,1);
});
test('image admission rejects paths, mixed parts, forced modes and text/image ID reuse before new input',async t=>{
  const f=await fixture(t);
  for(const change of [params=>params.message.push({type:'text',data:{text:'caption'}}),params=>params.message[0].data.path=f.source,
    params=>params.message[0].data.id='bad',params=>params.wechatagent_reply_mode='voice']){
    const request=f.request();change(request.params);const result=await f.backend.action(request);assert.equal(result.status,'failed');assert.equal(result.data.attempted,false);
  }
  assert.equal(f.backend.allJobs().length,0);
  assert.equal((await f.backend.action(f.request())).status,'ok');assert.equal((await f.backend.action(f.request(id('1'),false))).message,'UI_DELIVERY_ID_CONFLICT');
  f.advance(1);assert.equal((await f.backend.action(f.request(id('2'),false))).status,'ok');assert.equal((await f.backend.action(f.request(id('2')))).message,'UI_DELIVERY_ID_CONFLICT');
  assert.equal((await f.backend.action(f.query(id('3')))).data.state,'not_found');assert.equal(f.events.length,0);
});
test('restart and target revocation retain image receipt-only access without a new grant or submission',async t=>{
  const f=await fixture(t);await f.backend.action(f.request());await f.backend.tick();await f.backend.shutdown();const restored=f.create();
  await f.selectionStore.replace({expectedVersion:f.selectionStore.get().version,targetWxids:[]});f.state.imageConfirmed=true;
  await restored.tick();assert.equal((await restored.action(f.query())).data.state,'confirmed');assert.equal(f.events.filter(event=>event==='paste-image').length,1);
  assert.equal((await restored.action(f.request(id('2')))).status,'failed');
});
test('submitted image blocks text input while both receipts and global pause remain effective',async t=>{
  const f=await fixture(t);await f.backend.action(f.request());await f.backend.tick();f.advance(1);await f.backend.action(f.request(id('2'),false));
  f.backend.outbox.pause();await f.backend.tick();assert.equal(f.events.includes('paste-text'),false);assert(f.events.includes('image-receipt'));
  f.state.imageConfirmed=true;await f.backend.tick();await f.backend.tick();assert.equal(f.events.includes('paste-text'),false);
  f.backend.outbox.resume();await f.backend.tick();assert.equal(f.events.includes('paste-text'),true);
});
test('a cancelled pasted image and an uncertain image submission block subsequent text',async t=>{
  const f=await fixture(t),paste=f.native.pasteImage;f.native.pasteImage=async(...args)=>{const result=await paste(...args);f.backend.imageOutbox.pause(id('1'));return result;};
  await f.backend.action(f.request());await f.backend.tick();assert.equal(f.events.includes('submit-image'),false);
  f.backend.imageOutbox.cancel(id('1'));f.advance(1);await f.backend.action(f.request(id('2'),false));await f.backend.tick();assert.equal(f.events.includes('paste-text'),false);
  assert.equal(f.backend.getJob(id('1')).nativeRecoveryRequired,true);
});
test('unconfirmed text never unlocks the image queue',async t=>{
  const f=await fixture(t);f.state.textConfirmed=false;await f.backend.action(f.request(id('1'),false));await f.backend.tick();f.advance(1);await f.backend.action(f.request(id('2')));
  await f.backend.tick();assert.equal(f.events.includes('prepare-image'),false);f.advance(30000);await f.backend.tick();assert.equal(f.backend.getJob(id('1')).state,'unconfirmed');
  await f.backend.tick();assert.equal(f.events.includes('paste-image'),false);
});
test('the same applied image resumes its parked editor through the native proof without another search or paste',async t=>{
  const f=await fixture(t);f.state.pauseImageOnce=true;f.state.resumeProof=true;await f.backend.action(f.request());await f.backend.tick();
  assert.equal(f.backend.imageOutbox.get(id('1')).imageDraftPresent,true);assert.equal(f.events.includes('submit-image'),false);
  f.advance(1);await f.backend.action(f.request(id('2'),false));await f.backend.tick();
  assert.equal(f.events.filter(event=>event==='prepare-image').length,1);assert.equal(f.events.filter(event=>event==='paste-image').length,1);
  assert.equal(f.events.filter(event=>event==='resume-image').length,1);assert.equal(f.events.filter(event=>event==='submit-image').length,1);assert.equal(f.events.includes('paste-text'),false);
});
test('missing native image proof creates a manual recovery hold instead of searching or pasting again',async t=>{
  const f=await fixture(t);f.state.pauseImageOnce=true;f.state.resumeProof=false;await f.backend.action(f.request());await f.backend.tick();await f.backend.tick();
  const job=f.backend.imageOutbox.get(id('1'));assert.equal(job.manualPause,true);assert.equal(job.reason,'UI_IMAGE_DRAFT_RECOVERY_REQUIRED');
  await f.backend.tick();assert.equal(f.events.includes('resume-image'),false);assert.equal(f.events.includes('submit-image'),false);assert.equal(f.events.filter(event=>event==='paste-image').length,1);
});
test('one global pause prevents image preparation and concurrent ticks share a single desktop action',async t=>{
  const f=await fixture(t);await f.backend.action(f.request());f.backend.outbox.pause();await f.backend.tick();assert.equal(f.events.includes('prepare-image'),false);f.backend.outbox.resume();
  let release;const original=f.native.pasteImage;f.native.pasteImage=async(...args)=>{await new Promise(resolve=>release=resolve);return original(...args);};
  const first=f.backend.tick();while(!release)await pause();const second=f.backend.tick();assert.equal(first,second);release();await Promise.all([first,second]);assert.equal(f.events.filter(event=>event==='paste-image').length,1);
});
test('shutdown waits for the active image operation and never admits a following text',async t=>{
  const f=await fixture(t);await f.backend.action(f.request());let release;f.native.pasteImage=async()=>{await new Promise(resolve=>release=resolve);return{performed:false,attempted:false};};
  const tick=f.backend.tick();while(!release)await pause();let stopped=false;const shutdown=f.backend.shutdown().then(()=>stopped=true);await pause();assert.equal(stopped,false);
  release();await tick;await shutdown;assert.equal(stopped,true);assert.equal((await f.backend.action(f.request(id('2'),false))).status,'failed');assert.equal(f.events.includes('submit-image'),false);
});
test('image native guard rereads permission, pause and selected-delivery authorization after asynchronous preparation',async()=>{
  let enabled=true,paused=false,selected=true,reads=0,check,keys;
  const authorization=createSynchronousUiConfigScope(()=>{reads++;return{enabled};});
  const native={prepare:async()=>({ready:true}),observe:async()=>({ready:true}),pasteImage:async(_job,guard,local)=>{keys=Object.keys(guard);check=local.canInput;return{performed:true,attempted:true};},submitImage:async(_job,guard,local)=>{check=local.canSubmit;return{performed:true,attempted:true};}};
  const driver=createImageUiDriver({native,currentPlan:plan,authorizationScope:authorization.run,inputAllowed:()=>authorization.read().enabled,
    authorizeDelivery:job=>{assert.equal(job.text,'[IMAGE:'+id('a')+']');return selected&&authorization.read().enabled;},control:()=>({paused})});
  const job={id:id('1'),mode:'image',sourceImageSha256:id('a')};await driver.pasteImage(job,{canInput:()=>true,canSubmit:()=>true,activityRevision:'fixture'});assert.deepEqual(keys,['activityRevision']);assert.equal(reads,1);
  assert.equal(check(),true);assert.equal(reads,2);enabled=false;assert.equal(check(),false);enabled=true;paused=true;assert.equal(check(),false);paused=false;selected=false;assert.equal(check(),false);
  assert.equal((await driver.submitImage(job,{})).attempted,false);
});
test('known image preparation refusal uses the shared durable backoff instead of repeatedly borrowing focus',async t=>{
  const f=await fixture(t);let preparations=0;
  f.native.prepare=async()=>{preparations++;return{ready:false,reason:'QT_ACTIVITY_WARMUP'};};
  await f.backend.action(f.request());await f.backend.tick();assert.equal(preparations,1);assert.equal(f.backend.outbox.control().preparation.reason,'QT_ACTIVITY_WARMUP');
  await f.backend.tick();await f.backend.tick();assert.equal(preparations,1);f.advance(1001);await f.backend.tick();assert.equal(preparations,2);
  assert.equal(f.events.includes('paste-image'),false);
});
test('pre-focus account refusal persists a shared manual pause without tearing down the Reader boundary',async t=>{
  const f=await fixture(t);let preparations=0;f.native.prepare=async()=>{preparations++;throw Object.assign(Error('fixture preflight'),{code:'UI_ACCOUNT_PROBE_FAILED',attempted:false,
    accountPreflightRefusal:{version:1,stage:'background-account',focusBorrowed:false,voiceLeasePresent:false,messageInputAttempted:false,cleanupRequired:false}});};
  await f.backend.action(f.request());await f.backend.tick();assert.equal(f.backend.stopped,false);assert.equal(f.backend.outbox.control().paused,true);
  f.backend.outbox.resume();await f.backend.tick();assert.equal(preparations,1);assert.equal(f.events.includes('paste-image'),false);
});
test('unknown image preparation and cleanup errors propagate instead of turning into repeated observation retries',async t=>{
  const f=await fixture(t);f.native.prepare=async()=>{throw Object.assign(Error('fixture cleanup'),{code:'UI_QT_CLEANUP_UNCONFIRMED'});};
  await f.backend.action(f.request());await assert.rejects(f.backend.tick(),{code:'UI_QT_CLEANUP_UNCONFIRMED'});
  assert.equal(f.backend.outbox.control().paused,true);assert.equal(f.events.includes('paste-image'),false);
  await f.backend.tick();assert.equal(f.events.includes('paste-image'),false);
});
test('global pause interrupts pending image navigation immediately and keeps the unsent job',async t=>{
  const f=await fixture(t);let entered=false,aborted=false;
  f.native.prepare=async(_job,{signal})=>{entered=true;await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Object.assign(Error('fixture cancelled'),{code:'UI_QT_CANCELLED'}));},{once:true}));};
  await f.backend.action(f.request());const tick=f.backend.tick();while(!entered)await pause();f.backend.outbox.pause();await tick;
  assert.equal(aborted,true);assert.equal(f.backend.stopped,false);assert.equal(f.events.includes('paste-image'),false);assert.equal(f.backend.imageOutbox.get(id('1')).state,'waiting');
});
test('duplicate IDs in separate persisted lanes are rejected on read without guessing a route',async t=>{
  const f=await fixture(t);await f.backend.action(f.request());f.backend.outbox.enqueue({deliveryId:id('1'),account:f.account,target:f.target,text:'unrelated fixture',selectionScope:f.scope});
  const result=await f.backend.action(f.query());assert.equal(result.status,'failed');assert.equal(result.message,'UI_DELIVERY_ID_CONFLICT');assert.equal(f.events.length,0);
});
