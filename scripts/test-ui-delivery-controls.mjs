import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {createUiDeliveryControls} from './ui-delivery-controls.mjs';import {UiTextOutbox} from './ui-text-outbox.mjs';import {UiReplyOutbox} from './ui-reply-outbox.mjs';import {UiImageOutbox} from './ui-image-outbox.mjs';
import {createConsole} from './console-server.mjs';import {projectRoot} from './project-config.mjs';import {createDeliveryQueueUI} from '../public/console/delivery-queue.js';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex'),id=digit=>digit.repeat(64),deny=()=>assert.fail('controls must never invoke desktop or synthesis');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ui-delivery-controls-')),account='fixture-self',accountRef=id('a'),target='fixture-friend';let active={account,accountRef};
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^ui-delivery-controls-/);fs.rmSync(root,{recursive:true,force:true});});
  const textDirectory=path.join(root,'state/ui-text-deliveries',hash(account)),imageDirectory=path.join(root,'state/ui-image-deliveries',hash(account));
  const text=new UiTextOutbox({directory:textDirectory,driver:{observe:deny,typeGrapheme:deny,submit:deny,receipt:deny}}),replies=new UiReplyOutbox({directory:path.join(textDirectory,'routes'),textOutbox:text,voiceOutbox:{get:()=>null}});
  const images=new UiImageOutbox({directory:imageDirectory,driver:{prepare:deny,observe:deny,pasteImage:deny,submitImage:deny},receipts:{prepare:deny,submitted:deny,query:deny},authorizeScope:()=>false});
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=','base64'),source=path.join(root,'fixture.png');fs.writeFileSync(source,png);
  const scope={version:1,accountRef,account,target,eventId:'fixture-event',selectionVersion:1,grantId:id('b'),token:id('c')};
  text.enqueue({deliveryId:id('1'),account,target,text:'private fixture body'});replies.enqueue({deliveryId:id('2'),account,target,text:'private fixture voice',replyMode:'voice',selectionScope:scope});
  images.enqueue({deliveryId:id('3'),account,target,image:{path:source,sha256:hash(png)},selectionScope:scope});
  const controls=createUiDeliveryControls({root,accountProvider:()=>active,helpersStopped:async()=>true});
  const change=(job,operation)=>controls.change({accountRef:active.accountRef,id:job.id,version:job.version,operation});
  return{root,account,accountRef,text,replies,images,controls,change,imageDirectory,textDirectory,setAccount:next=>active=next};
}
test('current-account queue lists text, voice and images without body, asset path or private grants',t=>{
  const f=fixture(t),snapshot=f.controls.snapshot();assert.deepEqual(snapshot.jobs.map(job=>job.kind).sort(),['image','text','voice']);
  const serialized=JSON.stringify(snapshot);for(const hidden of ['private fixture',f.root,id('c'),'sourceImageSha256'])assert.equal(serialized.includes(hidden),false);
  assert(snapshot.jobs.every(job=>job.canPause&&job.canCancel&&!job.canResume));
  f.setAccount({account:'another-account',accountRef:id('d')});assert.deepEqual(f.controls.snapshot().jobs,[]);
});
test('chat-scoped previews include active bodies and archived sends only for the selected account and conversation',t=>{
  const f=fixture(t),readerDir=path.join(f.root,'state/reader-service');
  const targets=['fixture-friend','fixture-group@chatroom'].map(wxid=>({
    wxid,id:String(Number(crypto.createHash('sha256').update(wxid).digest().readBigUInt64BE()%2147483647n+1n)),
    label:'同名',alias:'',grantId:id('b')
  }));
  const roster={schemaVersion:1,version:1,updatedAt:1,accountRef:f.accountRef,automaticReplies:false,targets};
  fs.mkdirSync(readerDir,{recursive:true});
  const file=path.join(readerDir,'selection.json');
  fs.writeFileSync(file,JSON.stringify(roster));
  const scope={accountRef:f.accountRef,conversationKey:'wechat:private:'+targets[0].id};
  const group={...scope,conversationKey:'wechat:group:'+targets[1].id};
  const other=f.text.enqueue({account:f.account,target:targets[1].wxid,deliveryId:id('4'),text:'other chat'});
  const list=()=>f.controls.snapshot(scope).jobs;
  const rows=list();
  assert.deepEqual(rows.map(r=>r.preview).sort(),['private fixture body','private fixture voice','fixture.png'].sort());
  assert.equal(rows.some(r=>r.target===other.target),false);
  assert(!JSON.stringify(rows).includes(f.root));
  assert.throws(()=>f.controls.change({...scope,id:other.id,version:f.controls.snapshot(group).jobs[0].version,operation:'cancel'}),{code:'UI_QUEUE_CHAT_MISMATCH'});
  assert.throws(()=>f.controls.snapshot({...scope,accountRef:id('9')}),{code:'UI_QUEUE_ACCOUNT_MISMATCH'});
  f.replies.cancel(id('2'));f.replies.prune();
  assert(list().some(r=>r.kind==='voice'&&r.state==='cancelled'&&r.archived&&r.preview==='private fixture voice'));
  f.text.cancel(id('1'));f.text.prune();
  assert(list().some(r=>r.kind==='text'&&r.archived&&r.preview==='private fixture body'));
  assert.equal(list().length,3);
  fs.writeFileSync(file,JSON.stringify({...roster,version:2,targets:[targets[1]]}));
  assert.throws(list,{code:'UI_QUEUE_CHAT_NOT_SELECTED'});
});
test('queue explains clipboard waits separately from pauses requiring operator review',async t=>{
  const f=fixture(t),file=path.join(f.textDirectory,'routes','preparation-control.json');
  const timestamp=Date.now();
  for(const [kind,reason,expected] of [
    ['activity','DRAFT_CLIPBOARD_COMPLEX_FORMAT','waiting'],
    ['manual','DRAFT_CLIPBOARD_COMPLEX_FORMAT','review'],
    ['manual','UIA_MODE_RESULT_UNCONFIRMED',undefined],
  ]){
    fs.writeFileSync(file,JSON.stringify({version:1,revision:1,kind,reason,deliveryId:id('1'),attempts:1,
      updatedAt:timestamp,nextAttemptAt:kind==='activity'?timestamp+1000:0}));
    const state=f.controls.snapshot();
    assert.equal(state.clipboardState,expected);
    assert.equal(state.paused,kind==='manual');
    assert.equal(JSON.stringify(state).includes(reason),false);
  }
});
test('per-job pause, resume and cancel update only that durable queue with optimistic versions',t=>{
  const f=fixture(t);
  for(const original of f.controls.snapshot().jobs){
    const paused=f.change(original,'pause').job;assert.equal(paused.manualPause,true);assert.equal(paused.canResume,true);
    assert.throws(()=>f.change(original,'resume'),{code:'UI_QUEUE_VERSION_CONFLICT'});
    const resumed=f.change(paused,'resume').job;assert.equal(resumed.manualPause,false);
    assert.equal(f.change(resumed,'cancel').job.state,'cancelled');
  }
  assert.equal(f.controls.snapshot().jobs.filter(job=>job.state==='cancelled').length,3);
});
test('a fully applied paused image can request native-only resume; stopped-service clearing cancels without resending',async t=>{
  const f=fixture(t),file=path.join(f.imageDirectory,'queue/jobs',id('3')+'.json'),job=JSON.parse(fs.readFileSync(file));
  job.state='paused';job.manualPause=true;job.index=job.text.length;fs.writeFileSync(file,JSON.stringify(job));
  fs.writeFileSync(path.join(f.imageDirectory,'metadata',id('3')+'.json.application'),JSON.stringify({version:1,id:id('3'),applied:true,appliedAt:Date.now()}));
  const current=f.controls.snapshot().jobs.find(job=>job.id===id('3'));assert.equal(current.requiresRecovery,true);assert.equal(current.canResume,true);
  assert.equal(f.change(current,'resume').job.manualPause,false);assert.equal(f.images.get(id('3')).imageDraftPresent,true);
  f.images.pause(id('3'));const paused=f.controls.snapshot().jobs.find(job=>job.id===id('3'));assert.equal(f.change(paused,'cancel').job.requiresRecovery,true);
  assert.equal(f.images.get(id('3')).imageDraftPresent,true);assert.equal(f.images.get(id('3')).nativeRecoveryRequired,true);
  const cancelled=f.controls.snapshot().jobs.find(job=>job.id===id('3')),request={accountRef:f.accountRef,id:cancelled.id,version:cancelled.version,operation:'recover-image',acknowledgedCleared:true};
  fs.writeFileSync(path.join(f.root,'state/ui-service.lock'),'fixture running');await assert.rejects(f.controls.recoverImage(request),{code:'UI_QUEUE_STOP_REQUIRED'});fs.unlinkSync(path.join(f.root,'state/ui-service.lock'));
  await assert.rejects(f.controls.recoverImage({...request,acknowledgedCleared:false}),{code:'UI_QUEUE_REQUEST_INVALID'});
  const recovered=await f.controls.recoverImage(request);assert.equal(recovered.job.state,'cancelled');assert.equal(recovered.job.requiresRecovery,false);assert.equal(recovered.job.canResume,false);
  assert.equal(f.images.get(id('3')).nativeRecoveryRequired,false);assert.equal(f.images.get(id('3')).manualDraftCleared,true);
  assert(fs.existsSync(path.join(f.imageDirectory,'metadata',id('3')+'.json.application')));assert.equal(fs.existsSync(path.join(f.root,'state/ui-service.lock')),false);
});
test('unknown submission is not resumed, cancelled into retry or allowed to escape its account',async t=>{
  const f=fixture(t),file=path.join(f.textDirectory,'jobs',id('1')+'.json'),saved=JSON.parse(fs.readFileSync(file));saved.state='unconfirmed';saved.index=saved.text.length;saved.submittedAt=Date.now();saved.deadlineAt=saved.submittedAt+1000;fs.writeFileSync(file,JSON.stringify(saved));
  const job=f.controls.snapshot().jobs.find(job=>job.id===id('1'));assert.equal(job.canResume,false);assert.equal(job.canCancel,false);
  for(const operation of ['pause','resume','cancel'])assert.throws(()=>f.change(job,operation),{code:'UI_QUEUE_RECOVERY_REQUIRED'});
  assert.throws(()=>f.controls.change({accountRef:id('f'),id:job.id,version:job.version,operation:'pause'}),{code:'UI_QUEUE_ACCOUNT_MISMATCH'});
  await assert.rejects(f.controls.recoverImage({accountRef:f.accountRef,id:job.id,version:job.version,operation:'recover-image',acknowledgedCleared:true}),{code:'UI_QUEUE_RECOVERY_REQUIRED'});
  assert.equal(f.text.get(id('1')).state,'unconfirmed');
});
test('draft recovery retains the original barrier when helper stop or account continuity is not proved',async t=>{
  const f=fixture(t),file=path.join(f.imageDirectory,'queue/jobs',id('3')+'.json'),saved=JSON.parse(fs.readFileSync(file));saved.index=1;saved.state='paused';saved.manualPause=true;fs.writeFileSync(file,JSON.stringify(saved));
  const job=f.controls.snapshot().jobs.find(job=>job.id===id('3')),request={accountRef:f.accountRef,id:job.id,version:job.version,operation:'recover-image',acknowledgedCleared:true};
  assert.equal(job.canResume,false);assert.throws(()=>f.change(job,'resume'),{code:'UI_QUEUE_RECOVERY_REQUIRED'});
  const unavailable=createUiDeliveryControls({root:f.root,accountProvider:()=>({account:f.account,accountRef:f.accountRef}),helpersStopped:async()=>false});
  await assert.rejects(unavailable.recoverImage(request),{code:'UI_QUEUE_STOP_REQUIRED'});assert.equal(f.images.get(id('3')).state,'paused');
  assert.equal(fs.existsSync(path.join(f.imageDirectory,'metadata',id('3')+'.json.cleared')),false);assert.equal(fs.existsSync(path.join(f.root,'state/ui-service.lock')),false);
});
async function serverFixture(t,{close=async()=>{},controls}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ui-delivery-http-'));fs.mkdirSync(path.join(root,'config'));fs.mkdirSync(path.join(root,'roles'));
  const config=JSON.parse(fs.readFileSync(path.join(projectRoot,'config/wechatagent.example.json')));fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify(config));fs.writeFileSync(path.join(root,'roles',config.persona.default+'.md'),'fixture');
  let quit=0;const app=createConsole({root,port:0,botControls:{close},uiDeliveryControls:controls??{snapshot:()=>({jobs:[]}),change:body=>({operation:body.operation})},onQuit:()=>{quit++;},fetchImpl:async()=>{throw Error('fixture no network');},processProbe:async()=>[]});
  const address=await app.start(),base='http://127.0.0.1:'+address.port,token=(await fetch(base+'/api/info').then(response=>response.json())).token;
  t.after(async()=>{app.server.closeAllConnections();if(app.server.listening)await new Promise(resolve=>app.server.close(resolve));assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
  return{app,get quit(){return quit;},request:async(route,{body,auth=true}={})=>{const result=await fetch(base+route,{method:body?'POST':'GET',headers:{...(auth?{'X-Console-Token':token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:result.status,body:await result.json()};}};
}
test('queue HTTP reads and mutations require local console authentication',async t=>{
  let writes=0;const f=await serverFixture(t,{controls:{snapshot:()=>({jobs:[]}),change:body=>{writes++;assert.equal(body.operation,'pause');return{changed:true};}}});
  assert.equal((await f.request('/api/ui-deliveries',{auth:false})).status,401);assert.equal((await f.request('/api/ui-deliveries',{body:{operation:'pause'},auth:false})).status,401);assert.equal(writes,0);
  assert.deepEqual((await f.request('/api/ui-deliveries')).body,{jobs:[]});assert.equal((await f.request('/api/ui-deliveries',{body:{operation:'pause'}})).body.changed,true);assert.equal(writes,1);
});
test('standalone quit awaits owned model cleanup before acknowledging and leaves console alive on unknown cleanup',async t=>{
  let release,started=false;const f=await serverFixture(t,{close:()=>{started=true;return new Promise(resolve=>release=resolve);}});let answered=false;
  const response=f.request('/api/quit',{body:{}}).then(value=>{answered=true;return value;});while(!started)await new Promise(resolve=>setImmediate(resolve));assert.equal(answered,false);assert.equal(f.quit,0);release();assert.equal((await response).status,200);
  await new Promise(resolve=>setTimeout(resolve,130));assert.equal(f.quit,1);
  const g=await serverFixture(t,{close:async()=>{throw Error('private cleanup detail');}});const failed=await g.request('/api/quit',{body:{}});assert.equal(failed.status,503);assert.equal(g.app.server.listening,true);assert.equal(g.quit,0);assert.match(failed.body.error,/语音服务尚未确认停止/);assert.equal(JSON.stringify(failed).includes('private cleanup'),false);
});
function panelHost(key,wxid){
  const body={},refresh={dataset:{},disabled:false},host={dataset:{accountRef:id('a'),key,target:wxid},isConnected:true,
    querySelector:selector=>selector==='[data-delivery-body]'?body:refresh,contains:()=>host.isConnected};
  return {host,body,refresh};
}
test('chat queue separates messages by delivery state, escapes previews and sends scoped controls',async()=>{
  const key='wechat:private:123',target='fixture@id',scope={accountRef:id('a'),conversationKey:key},calls=[];
  const jobs=[
    {id:id('1'),version:id('2'),kind:'image',target,state:'paused',preview:'<photo>',canCancel:true},
    {id:id('3'),kind:'voice',target,state:'submitted',preview:'测试语音'},
    {id:id('4'),kind:'text',target,state:'unconfirmed',preview:'测试文本'},
    {id:id('5'),kind:'file',target,state:'confirmed',preview:'示例.pdf',archived:true}
  ];
  const ui=createDeliveryQueueUI({api:async(route,body)=>{calls.push({route,body});return {...scope,jobs,clipboardState:'review'};},
    escapeHtml:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),toast(){}});
  assert.match(ui.panel({key,wxid:target,name:'好友<fixture>'},scope.accountRef),/发给 好友&lt;fixture&gt;/);
  const {host,body}=panelHost(key,target);await ui.mount(host);const html=body.innerHTML;
  assert.equal(calls[0].route,'/api/ui-deliveries?'+new URLSearchParams(scope));
  assert.match(html,/待发送 <small>1<.*&lt;photo&gt;.*发送中 <small>1<.*测试语音.*待核对 <small>1<.*测试文本.*发送记录 <small>1<.*示例.pdf/s);
  assert.match(html,/恢复发送核验/);assert.doesNotMatch(html,/data-delivery-operation="resume"/);
  const button={dataset:{deliveryId:id('1'),deliveryOperation:'cancel'},closest:()=>button};
  host.onclick({target:button});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls[1],{route:'/api/ui-deliveries',body:{...scope,id:id('1'),version:id('2'),operation:'cancel'}});
});
test('a mismatched scope or late queue response cannot render another chat’s content',async()=>{
  const one=panelHost('wechat:private:1','A'),two=panelHost('wechat:private:2','B');let done;
  const ui=createDeliveryQueueUI({api:route=>route.includes('private%3A1')?new Promise(resolve=>{done=resolve;}):
    {accountRef:id('a'),conversationKey:two.host.dataset.key,jobs:[{target:'A',preview:'secret-other-chat'}]},escapeHtml:String,toast(){}});
  const first=ui.mount(one.host);one.host.isConnected=false;
  await ui.mount(two.host);
  done({accountRef:id('a'),conversationKey:one.host.dataset.key,jobs:[{target:'A',preview:'secret-other-chat'}]});await first;
  assert.equal(one.body.innerHTML,undefined);assert.match(two.body.innerHTML,/聊天名单已变化/);assert.doesNotMatch(two.body.innerHTML,/secret-other-chat/);
});
