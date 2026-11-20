import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { UiOneBotBackend, UiOneBotConnection, UI_DELIVERY_PROTOCOL, uiOneBotId, createReceiptUiDriver, createSynchronousUiConfigScope, createUiBridgeModeGuard, runUiBridge,uiSenderJobsSwitchSafe } from './ui-onebot.mjs';
import {inspectPreparationControl,recoverPreparationControl} from './ui-reply-outbox.mjs';
import {consumeReaderStream} from './ui-reader-stream.mjs';
import { WechatOneBotAdapter } from '../components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js';

const id = 'a'.repeat(64);
test('sender switch accepts untouched queued work but rejects every input or submission uncertainty',()=>{
  const queued={state:'queued',index:0};assert.equal(uiSenderJobsSwitchSafe([]),true);
  for(const mode of ['text','image','voice'])assert.equal(uiSenderJobsSwitchSafe([{...queued,mode,nativeState:null}]),true,mode);
  for(const patch of [{index:1},{index:undefined},{pendingInput:{}},{inputPending:true},{imageDraftPresent:true},{nativeRecoveryRequired:true},{audioSha256:'a'.repeat(64)},{nativeState:'prepared'},{submittedAt:0},{deadlineAt:0},{segments:[{state:'record-intent'}]},...['typing','waiting','paused','conflict','submitting','submitted','unconfirmed','failed'].map(state=>({state}))])assert.equal(uiSenderJobsSwitchSafe([{...queued,...patch}]),false,JSON.stringify(patch));
  assert.equal(uiSenderJobsSwitchSafe([{state:'confirmed'},{state:'cancelled',index:0}]),true);
  assert.equal(uiSenderJobsSwitchSafe([{state:'cancelled',index:1}]),false);
  assert.equal(uiSenderJobsSwitchSafe([{state:'cancelled',index:1,manualDraftCleared:true}]),true);
  assert.equal(uiSenderJobsSwitchSafe([{state:'cancelled',manualDraftCleared:true,nativeRecoveryRequired:true}]),false);
});

test('queued delivery keeps its exact identity and state across drained sender replacement without input',async t=>{
  const f=fixture(t);await f.backend.action(f.request());const before=f.backend.allJobs();assert.equal(before.length,1);assert.equal(before[0].state,'queued');
  assert.equal(f.backend.senderSwitchSafe(),true);await f.backend.shutdown();assert.equal(f.backend.senderSwitchSafe(),true);
  const replacement=f.restart();assert.deepEqual(replacement.allJobs(),before);assert.deepEqual(f.actions,[]);
  assert.equal((await replacement.action(f.request())).data.delivery_id,id);assert.deepEqual(replacement.allJobs(),before);
});

test('manual preparation pause migrates with an untouched queue and is never cleared by sender replacement',async t=>{
  const f=fixture(t,{modeFor:()=> 'text'});await f.backend.action(f.request());
  const file=path.join(f.directory,createHash('sha256').update(f.policy.accountWxid).digest('hex'),'routes','preparation-control.json');
  const original=JSON.stringify({version:1,revision:107,kind:'manual',reason:'DRAFT_EXECUTABLE_MISMATCH',deliveryId:id,attempts:1,nextAttemptAt:0,updatedAt:1000});fs.writeFileSync(file,original);
  assert.equal(f.backend.outbox.control().paused,true);assert.equal(f.backend.senderSwitchSafe(),true);const jobs=f.backend.allJobs();
  await f.backend.shutdown();const replacement=f.restart();assert.equal(replacement.senderSwitchSafe(),true);assert.equal(replacement.outbox.control().paused,true);
  assert.equal(replacement.outbox.control().preparation.reason,'DRAFT_EXECUTABLE_MISMATCH');assert.deepEqual(replacement.allJobs(),jobs);assert.equal(fs.readFileSync(file,'utf8'),original);
  await replacement.tick();assert.deepEqual(f.actions,[]);assert.equal(fs.readFileSync(file,'utf8'),original);
});

test('standalone bridges bind the saved UIA revision and cannot silently use the ordinary driver',async t=>{
  const f=fixture(t),root=f.directory,file=path.join(root,'state/runtime/uia-mode.json');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const save=(version,enabled,schemaVersion=2)=>fs.writeFileSync(file,JSON.stringify({schemaVersion,version,enabled,...(schemaVersion===2?{backend:'uia'}:{})}));
  save(3,true);
  const mode=createUiBridgeModeGuard({root,driver:'qt-visual'});assert.equal(mode.enabled,true);assert.equal(mode.version,3);assert.equal(mode.assertCurrent(),true);
  assert.throws(()=>createUiBridgeModeGuard({root,uiaMode:false,driver:'qt-visual'}),{code:'UIA_MODE_STATE_CHANGED'});
  assert.throws(()=>createUiBridgeModeGuard({root,driver:'uia'}),{code:'UIA_MODE_DRIVER_REQUIRED'});
  const hostConfig=path.join(root,'fixture-config.json');fs.writeFileSync(hostConfig,'{}');
  const config={version:1,...f.policy,accountDirectory:'fixture-account',hostConfig,enableInput:true,allowSubmit:true,driver:'qt-visual',reader:{baseUrl:'http://127.0.0.1:1',token:'b'.repeat(64)},onebotUrl:'ws://127.0.0.1:2/ws'};
  await assert.rejects(runUiBridge({root,config,uiaMode:false}),{code:'UIA_MODE_STATE_CHANGED'});
  save(4,true);assert.throws(()=>mode.assertCurrent(),{code:'UIA_MODE_STATE_CHANGED'});
  const refreshed=createUiBridgeModeGuard({root,driver:'qt-visual'});save(5,false);assert.throws(()=>refreshed.assertCurrent(),{code:'UIA_MODE_STATE_CHANGED'});
  const disabled=createUiBridgeModeGuard({root,driver:'qt-visual'});assert.equal(disabled.enabled,false);save(6,true);assert.throws(()=>disabled.assertCurrent(),{code:'UIA_MODE_STATE_CHANGED'});
  save(7,true,1);assert.equal(createUiBridgeModeGuard({root,driver:'qt-visual'}).enabled,false);
  for(const driver of ['uia',undefined]){
    assert.throws(()=>createUiBridgeModeGuard({root,driver}),{code:'UIA_MODE_DRIVER_REQUIRED'});
    await assert.rejects(runUiBridge({root,config:{...config,driver}}),{code:'UIA_MODE_DRIVER_REQUIRED'});
  }
  assert.throws(()=>createUiBridgeModeGuard({root,uiaMode:true,driver:'qt-visual'}),{code:'UIA_MODE_STATE_CHANGED'});
});

test('UIA refusal codes survive receipt guards and OneBot status without admitting native input',async t=>{
  const f=fixture(t);let prepared=0;
  const driver=createReceiptUiDriver({native:{...f.driver,prepare:()=>{prepared++;}},receipts:{},inputAllowed:()=>{throw Object.assign(Error('private detail'),{code:'UIA_MODE_STATE_CHANGED'});}});
  assert.deepEqual(await driver.prepare({}),{ready:false,reason:'UIA_MODE_STATE_CHANGED'});
  assert.deepEqual(await driver.typeGrapheme({},{}),{performed:false,attempted:false,reason:'UIA_MODE_STATE_CHANGED'});assert.equal(prepared,0);
  f.backend.stop();f.driver.prepare=async()=>({ready:false,reason:'UIA_MODE_GEOMETRY_CHANGED'});const backend=f.restart();
  await backend.action(f.request());await backend.tick();assert.equal(backend.status().reason,'UIA_MODE_GEOMETRY_CHANGED');assert.equal(f.actions.length,0);
});

test('shutdown waits for every native cleanup even when an active operation fails',async t=>{
  const f=fixture(t);let release,closed=false;
  f.driver.close=()=>new Promise(resolve=>{release=()=>{closed=true;resolve();};});
  f.backend.outbox.activeTick=Promise.reject(Object.assign(new Error('fixture'),{code:'UI_INPUT_UNCERTAIN'}));
  let finished=false;const shutdown=f.backend.shutdown().then(()=>finished=true);
  await delay(10);assert.equal(finished,false);release();await shutdown;assert.equal(closed,true);
});
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Fixture timed out'); await delay(10); }
}
function fixture(t,options={}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-onebot-contract-'));
  const policy = { accountWxid: 'fixture_account', targets: [{ kind: 'private', id: uiOneBotId('filehelper'), wxid: 'filehelper' }] };
  const state = { ready: false, account: policy.accountWxid, target: 'filehelper', foreground: true, idleMs: 10000,
    draft: '', editorToken: 'fixture-editor', activityRevision: 1 };
  const actions = [];
  const driver = {
    observe: async () => structuredClone(state),
    typeGrapheme: async (_job, guard) => { assert.equal(guard.expectedDraft, state.draft); actions.push('type'); state.draft += guard.text; return { performed: true }; },
    submit: async (_job, guard) => { assert.equal(guard.expectedDraft, state.draft); actions.push('submit'); state.draft = ''; return { performed: true }; },
    receipt: async job => ({ confirmed: true, receipt: { type: 'wechat-database-text-v1', deliveryId: job.id, account: job.account, target: job.target,
      textSha256: createHash('sha256').update(job.text).digest('hex'), serverId: '100' } }),
    close: () => {},
  };
  const create = () => new UiOneBotBackend({ directory, policy, policyProvider: () => policy, driver, settings: { idleMs: 10, intervalMs: 0, punctuationPauseMs: 0 },...options });
  let backend = create();
  t.after(() => {
    backend.stop();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('ui-onebot-contract-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const request = (text = '测试') => ({ action: 'send_private_msg', params: { user_id: Number(policy.targets[0].id), self_id: backend.selfId,
    wechatagent_delivery_protocol: UI_DELIVERY_PROTOCOL, wechatagent_delivery_id: id, message: [{ type: 'text', data: { text } }] }, echo: 'fixture' });
  const query = () => ({ action: 'get_wechatagent_delivery', params: { self_id: backend.selfId, kind: 'private', target: policy.targets[0].id,
    wechatagent_delivery_protocol: UI_DELIVERY_PROTOCOL, wechatagent_delivery_id: id } });
  return { directory, policy, state, actions, driver, request, query, get backend() { return backend; }, restart() { backend.stop(); backend = create(); return backend; } };
}

test('native text replies bind the selected source across restarts and never downgrade to plain text',async t=>{
  const serverId='9876543210123456789', target='filehelper';
  const quote={id:createHash('sha256').update(target+'\0'+serverId).digest('hex'),serverId,text:'source text',sender:target,timestamp:1234};
  let available=true;
  const f=fixture(t,{resolveQuote:async(talker,id)=>{
    assert.equal(talker,target); assert.equal(id,quote.id);
    if(!available)throw Error('target disappeared');
    return quote;
  }});
  f.driver.prepare=async()=>({ready:true}); f.restart();
  assert.ok(f.backend.meta().wechatagent_capabilities.includes('native-quote-reply-v1'));
  const req=f.request('reply');
  req.params.message.unshift({type:'reply',data:{id:quote.id}});
  assert.equal((await f.backend.action(req)).data.state,'queued');
  f.restart();
  assert.deepEqual(f.backend.allJobs()[0].quote,quote);
  assert.equal((await f.backend.action(f.request('reply'))).message,'UI_DELIVERY_ID_CONFLICT');
  assert.equal((await f.backend.action(req)).data.state,'queued');
  available=false; await f.backend.tick();
  assert.equal(f.backend.status().queue.cancelled,1);
  assert.equal(f.backend.outbox.control().paused,false);
  assert.equal(f.backend.allJobs()[0].reason,'UI_QUOTE_TARGET_UNAVAILABLE');
  assert.deepEqual(f.actions,[]);
  const plain=fixture(t);assert.equal((await plain.backend.action(req)).message,'UI_QUOTE_UNAVAILABLE');
});

test('a quoted attachment survives restart and refreshes its location before selecting the bubble',async t=>{
  const serverId='3123456789', target='filehelper';
  const quote={id:createHash('sha256').update(target+'\0'+serverId).digest('hex'),serverId,sender:target,timestamp:1234,
    text:'[图片]',kind:'image',locator:{rows:[{kind:'text',text:'原图在下面'},{kind:'image'},{kind:'image'}],index:2,ocrAnchor:0}};
  const f=fixture(t,{richQuotes:true,resolveQuote:async()=>structuredClone(quote)});
  let prepared;
  f.driver.prepare=async job=>{prepared=job.quote;return {ready:true};}; f.restart();
  const req=f.request();req.params.message.unshift({type:'reply',data:{id:quote.id}});
  assert.ok(f.backend.meta().wechatagent_capabilities.includes('native-rich-quote-reply-v1'));
  assert.equal((await f.backend.action(req)).data.state,'queued');
  f.restart();assert.deepEqual(f.backend.allJobs()[0].quote,quote);
  quote.locator.rows.push({kind:'text',text:'看第二张'});
  await f.backend.tick();
  assert.deepEqual(prepared,quote);
  const old=fixture(t,{resolveQuote:async()=>quote});
  assert.equal((await old.backend.action(req)).message,'UI_QUOTE_UNAVAILABLE');
  assert.equal(old.backend.allJobs().length,0);
  quote.locator.index=0;
  const malformed=fixture(t,{richQuotes:true,resolveQuote:async()=>quote});
  assert.equal((await malformed.backend.action(req)).message,'UI_QUOTE_TARGET_INVALID');
});

test('UIA background capability crosses the guarded backend without relaxing target or receipt binding',async t=>{
  for(const allowed of [false,true]){
    const f=fixture(t,{allowUiaBackgroundText:allowed});Object.assign(f.state,{ready:true,foreground:false,inputTransport:'window-message-background-v1'});
    await f.backend.action(f.request('x'));for(let i=0;i<6;i++)await f.backend.tick();
    const result=await f.backend.action(f.query());assert.equal(result.data.state,allowed?'confirmed':'waiting');assert.equal(f.actions.includes('submit'),allowed);
  }
});

test('admission persists once and is never delivery; read-only queries cannot enqueue', async t => {
  const f = fixture(t);
  assert.equal((await f.backend.action(f.query())).data.state, 'not_found');
  assert.equal(f.backend.outbox.list().length, 0);
  const initial = await f.backend.action(f.request());
  assert.equal(initial.data.state, 'queued'); assert.equal(initial.data.receipt, undefined);
  assert.equal(f.actions.length, 0);
  await f.backend.tick();
  assert.equal((await f.backend.action(f.request())).data.state, 'waiting');
  assert.equal(f.backend.outbox.list().length, 1);
  const changed = await f.backend.action(f.request('different'));
  assert.equal(changed.message, 'UI_DELIVERY_ID_CONFLICT'); assert.equal(changed.data.rejected, undefined);
  assert.equal(f.backend.outbox.get(id).text, '测试');
  assert.equal(f.actions.length, 0);
});

test('recoverable native voice remains pending on the wire until its late receipt arrives',t=>{
  const f=fixture(t),target=f.policy.targets[0],job={id,account:f.policy.accountWxid,target:target.wxid,text:'fixture',state:'unconfirmed',nativeRecoveryRequired:true,reason:'NATIVE_VOICE_UNKNOWN'};
  const pending=f.backend.result(job,target,id);assert.equal(pending.state,'submitted');assert.equal(pending.receipt,undefined);assert.equal(job.state,'unconfirmed');
  const receipt={type:'wechat-native-voice-job-v1',nativeVoiceRowConfirmed:true};
  const confirmed=f.backend.result({...job,state:'confirmed',nativeRecoveryRequired:false,receipt},target,id);assert.equal(confirmed.state,'confirmed');assert.deepEqual(confirmed.receipt.evidence,receipt);
  assert.equal(f.backend.result({...job,nativeRecoveryRequired:false},target,id).state,'unconfirmed');assert.equal(f.actions.length,0);
});

test('preparation fault remains visible and blocks navigation until explicit recovery',async t=>{
  const f=fixture(t);f.backend.stop();f.driver.prepare=async()=>({ready:false,reason:'QT_WINDOW_OBSCURED'});const backend=f.restart();
  await backend.action(f.request());await backend.tick();assert.equal(backend.stopped,false);assert.equal(backend.status().ready,false);assert.equal(backend.status().reason,'QT_WINDOW_OBSCURED');assert.equal(f.actions.length,0);
  f.driver.prepare=async()=>({ready:false,reason:'private clipboard content'});await backend.tick();assert.equal(backend.status().reason,'QT_WINDOW_OBSCURED');assert.equal(f.actions.length,0);
  backend.outbox.resume();await backend.tick();assert.equal(backend.status().reason,'QT_WINDOW_OBSCURED');
  const directory=backend.outbox.directory;recoverPreparationControl(directory,{expectedRevision:inspectPreparationControl(directory).revision,assertStopped:()=>true});await backend.tick();assert.equal(backend.status().reason,'UI_PREPARATION_UNVERIFIED');assert.equal(f.actions.length,0);
});

test('account, target, protocol and unsupported media fail before queue admission', async t => {
  const f = fixture(t);
  for (const change of [{ self_id: '99' }, { user_id: 99 }, { wechatagent_delivery_protocol: 'legacy' }, { message: [{ type: 'record', data: { file: 'fixture' } }] }]) {
    const request = f.request(); Object.assign(request.params, change);
    assert.equal((await f.backend.action(request)).status, 'failed');
  }
  assert.equal(f.backend.outbox.list().length, 0);
  const proactive = f.request(); proactive.params.wechatagent_source = 'proactive';
  const response = await f.backend.action(proactive);
  assert.equal(response.message, 'UI_PROACTIVE_UNAVAILABLE'); assert.equal(response.data.attempted, false);
  assert.equal(response.data.rejected, true);
});

test('human activity and changed drafts pause the same job without overwriting', async t => {
  const f = fixture(t); f.state.ready = true;
  await f.backend.action(f.request()); await f.backend.tick();
  assert.equal(f.actions.length, 1);
  f.state.ready = false; f.state.activityRevision++;
  await f.backend.tick(); assert.equal(f.backend.outbox.get(id).state, 'paused');
  f.state.ready = true; f.state.draft = '保留的人工草稿';
  await f.backend.tick(); assert.equal(f.backend.outbox.get(id).state, 'conflict');
  assert.equal(f.state.draft, '保留的人工草稿'); assert.deepEqual(f.actions, ['type']);
});

test('restart, exact receipt binding and account-isolated storage prevent duplicate submission', async t => {
  const f = fixture(t); f.state.ready = true;
  await f.backend.action(f.request());
  await f.backend.tick();
  f.restart();
  for (let i = 0; i < 6; i++) await f.backend.tick();
  const response = await f.backend.action(f.query());
  assert.equal(response.data.state, 'confirmed');
  assert.equal(response.data.receipt.deliveryId, id); assert.equal(response.data.receipt.type, 'wechat-ui-delivery-v1');
  assert.equal(f.actions.filter(action => action === 'submit').length, 1);
  await f.backend.action(f.request()); await f.backend.tick();
  assert.equal(f.actions.filter(action => action === 'submit').length, 1);
  assert.equal(JSON.stringify(response).includes('测试'), false);
  f.policy.accountWxid = 'different_account';
  assert.equal((await f.backend.action(f.query())).message, 'UI_ACCOUNT_CHANGED');
});

test('policy removal blocks pending input and cannot turn an old query into a no-submission promise', async t => {
  const f = fixture(t); await f.backend.action(f.request()); f.state.ready = true;
  await f.backend.tick();
  assert.equal(f.backend.status().ready, true); assert.equal(f.backend.status().reason, null);
  const inputCount = f.actions.length;
  const query = f.query(); f.policy.targets = [];
  await f.backend.tick(); assert.equal(f.actions.length, inputCount);
  assert.equal(f.backend.status().ready, false); assert.equal(f.backend.status().reason, 'UI_TARGET_NOT_ALLOWED');
  const result = await f.backend.action(query);
  assert.equal(result.message, 'UI_TARGET_NOT_ALLOWED'); assert.equal(result.data.rejected, undefined);
});

test('incoming text maps only exact bound conversations and excludes self, duplicates and media', t => {
  const f = fixture(t);
  const payload = { event: 'message.new', type: 1, sessionId: 'filehelper', talkerId: 'filehelper', content: '你好', rawid: 'fixture-message', timestamp: 1 };
  assert.equal(f.backend.incoming({ ...payload, talkerId: f.policy.accountWxid }), null);
  assert.equal(f.backend.incoming({ ...payload, type: 3 }), null);
  assert.equal(f.backend.incoming({ ...payload, sessionId: 'another' }), null);
  assert.equal(f.backend.incoming({ ...payload, conversationId: '9' }), null);
  assert.equal(f.backend.incoming(payload).user_id, Number(uiOneBotId('filehelper')));
  assert.equal(f.backend.incoming(payload), null);
});

test('real local reverse WebSocket negotiates durable queue, waits for human idle and confirms once', async t => {
  const f = fixture(t);
  const adapter = new WechatOneBotAdapter({ server: { host: '127.0.0.1', port: 0, path: '/ws', timeoutMs: 1000 } });
  adapter.on('error', () => {});
  await adapter.start();
  const port = adapter.server.server.address().port;
  const connection = new UiOneBotConnection({ backend: f.backend, url: `ws://127.0.0.1:${port}/ws` });
  t.after(async () => { connection.stop(); await adapter.stop(); });
  const meta = once(adapter, 'meta'); await connection.start(); await meta;
  const send = () => adapter.sendText({ kind: 'private', target: f.policy.targets[0].id, selfId: f.backend.selfId, deliveryId: id, text: ' 测试 ' });
  const queued = await send();
  assert.equal(queued.pending, true); assert.equal(queued.confirmed, false); assert.equal(adapter.stats.sends, 0);
  await until(() => f.backend.outbox.get(id).state === 'waiting');
  assert.equal(f.actions.length, 0);
  f.state.ready = true;
  await until(() => f.backend.outbox.get(id).state === 'confirmed');
  const confirmed = await send(); assert.equal(confirmed.confirmed, true); assert.equal(adapter.stats.sends, 1);
  assert.equal(f.backend.outbox.get(id).text, ' 测试 ');
  await send(); assert.equal(adapter.stats.sends, 1); assert.equal(f.actions.filter(action => action === 'submit').length, 1);
  connection.stop(); assert.equal(f.backend.stopped, true);
});

test('focus acquisition refusal keeps the reverse WebSocket receiving while the queued reply remains paused',async t=>{
  const f=fixture(t);let prepares=0;
  f.driver.prepare=async()=>{prepares++;throw Object.assign(Error('fixture focus refusal'),{code:'QT_FOCUS_ACQUIRE_UNCONFIRMED'});};
  f.restart();
  const adapter=new WechatOneBotAdapter({server:{host:'127.0.0.1',port:0,path:'/ws',timeoutMs:1000}});adapter.on('error',()=>{});
  await adapter.start();const port=adapter.server.server.address().port;
  const connection=new UiOneBotConnection({backend:f.backend,url:`ws://127.0.0.1:${port}/ws`});
  t.after(async()=>{connection.stop();await adapter.stop();});
  const meta=once(adapter,'meta');await connection.start();await meta;
  const send=()=>adapter.sendText({kind:'private',target:f.policy.targets[0].id,selfId:f.backend.selfId,deliveryId:id,text:'fixture'});
  assert.equal((await send()).pending,true);
  await until(()=>f.backend.status().reason==='QT_FOCUS_ACQUIRE_UNCONFIRMED');
  await delay(120);assert.equal(connection.connected,true);assert.equal(f.backend.stopped,false);assert.equal(prepares,1);
  const received=once(adapter,'message');
  assert.equal(connection.sendIncoming({event:'message.new',type:1,sessionId:'filehelper',talkerId:'filehelper',content:'fixture incoming',rawid:'fixture-live-after-refusal',timestamp:1}),true);
  await received;
  const pending=await send();assert.equal(pending.pending,true);assert.equal(pending.confirmed,false);
  assert.equal(f.backend.outbox.get(id).state,'queued');assert.equal(f.backend.outbox.get(id).index,0);
  assert.equal(f.backend.outbox.control().paused,true);assert.equal(f.actions.length,0);assert.equal(adapter.stats.sends,0);
});

test('proved before-body UIA refusal keeps the connection receiving and never retries the paused queue',async t=>{
  class FakeSocket extends EventTarget{constructor(){super();this.readyState=0;this.sent=[];setImmediate(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}send(value){this.sent.push(value);}close(){if(this.readyState===3)return;this.readyState=3;this.dispatchEvent(new Event('close'));}}
  const f=fixture(t);let prepares=0;
  f.driver.prepare=async()=>{prepares++;throw Object.assign(Error('provider refused'),{code:'UIA_MODE_RESULT_UNCONFIRMED',attempted:false,uiaPreparationRefusal:{version:1,stage:'control-preparation',operation:'navigation-ready',focus:'restored',messageInputAttempted:false,draftPresent:false,cleanupConfirmed:true}});};f.restart();
  const connection=new UiOneBotConnection({backend:f.backend,url:'ws://127.0.0.1:1/ws',WebSocketImpl:FakeSocket});t.after(()=>connection.stop());await connection.start();
  await f.backend.action(f.request());await until(()=>f.backend.status().reason==='UIA_MODE_RESULT_UNCONFIRMED');await delay(120);
  assert.equal(connection.connected,true);assert.equal(connection.failure,undefined);assert.equal(f.backend.stopped,false);assert.equal(prepares,1);assert.equal(f.actions.length,0);
  assert.equal(connection.sendIncoming({event:'message.new',type:1,sessionId:'filehelper',talkerId:'filehelper',content:'fixture incoming',rawid:'uia-refusal-live',timestamp:1}),true);
  assert.equal(f.backend.outbox.get(id).state,'queued');assert.equal(f.backend.outbox.control().paused,true);f.backend.outbox.resume();await f.backend.tick();assert.equal(prepares,1);
});

test('fatal tick failure remains available when closing the Reader stream produces DOM AbortError code 20',async t=>{
  class FakeSocket extends EventTarget{constructor(){super();this.readyState=0;setImmediate(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}send(){}close(){if(this.readyState===3)return;this.readyState=3;this.dispatchEvent(new Event('close'));}}
  for(const code of ['UIA_MODE_RESULT_UNCONFIRMED','UIA_MODE_VERIFIER_CLEANUP_UNCONFIRMED']){
    const f=fixture(t),original=Object.assign(Error('private original failure'),{code,attempted:false});f.driver.prepare=async()=>{throw original;};f.restart();
    const connection=new UiOneBotConnection({backend:f.backend,url:'ws://127.0.0.1:1/ws',WebSocketImpl:FakeSocket});t.after(()=>connection.stop());
    const abort=new AbortController();let source;const body=new ReadableStream({start(controller){source=controller;}});
    abort.signal.addEventListener('abort',()=>source.error(new DOMException('fixture stream abort','AbortError')),{once:true});connection.onDisconnect=()=>abort.abort();
    const stream=consumeReaderStream({response:{ok:true,headers:{get:()=> 'text/event-stream'},body},journal:{read:()=>({cursor:'0',pending:null})},dispatch:()=>{},signal:abort.signal}).catch(error=>error);
    await connection.start();await f.backend.action(f.request());const secondary=await stream;
    assert.equal(secondary.name,'AbortError');assert.equal(secondary.code,20);assert.equal(connection.failure,original);assert.equal(connection.failure.code,code);
    assert.equal(connection.connected,false);assert.equal(f.backend.stopped,true);assert.equal(f.actions.length,0);
  }
});

test('config scope shares only one synchronous read and ends on return, throw and await', async () => {
  let reads=0,current={enabled:true};const scope=createSynchronousUiConfigScope(()=>{reads++;return structuredClone(current);});
  scope.run(()=>{
    const first=scope.read();first.enabled=false;
    assert.equal(scope.run(()=>scope.read()).enabled,true);assert.equal(reads,1);
  });
  assert.equal(scope.read().enabled,true);assert.equal(reads,2);
  assert.throws(()=>scope.run(()=>{scope.read();throw Error('fixture');}),/fixture/);
  current.enabled=false;assert.equal(scope.run(()=>scope.read()).enabled,false);assert.equal(reads,4);
  current.enabled=true;
  await scope.run(async()=>{
    assert.equal(scope.read().enabled,true);assert.equal(reads,5);
    await Promise.resolve();current.enabled=false;
    assert.equal(scope.read().enabled,false);assert.equal(reads,6);
  });
});

test('receipt authorization shares config within each check but rereads after receipt preparation',async()=>{
  let reads=0,allowed=true,submits=0,discarded=0,finish;
  const scope=createSynchronousUiConfigScope(()=>{reads++;return {allowed};});
  const driver=createReceiptUiDriver({authorizationScope:scope.run,inputAllowed:()=>scope.read().allowed,
    native:{submit:()=>{submits++;},close(){}},receipts:{
      prepare:()=>new Promise(resolve=>{finish=resolve;}),
      markNotSubmitted:async()=>{discarded++;return {notSubmitted:true};},
    }});
  const pending=driver.submit({}, {canSubmit:()=>scope.read().allowed});
  assert.equal(reads,1);assert.equal(typeof finish,'function');
  allowed=false;finish({submissionAllowed:true,preparationToken:'fixture'});
  const result=await pending;assert.equal(result.attempted,false);assert.equal(submits,0);assert.equal(discarded,1);assert.equal(reads,2);
});

test('receipt barrier overlaps only native read-only work and persists before its sole input',async()=>{
  const calls=[];let finish;
  const native={textSubmitPreparationPolicy:'receipt-barrier-v1',async submit(_job,guard,local){
    assert.equal(Object.hasOwn(guard,'beforeSubmit'),false);calls.push('read-only');
    const ready=await local.beforeSubmit();assert.deepEqual(ready,{ready:true,proof:'receipt-baseline-persisted-v1'});
    assert.equal(local.canSubmit(),true);calls.push('input');return{performed:true,attempted:true};
  }};
  const receipts={prepare:()=>{calls.push('baseline');return new Promise(resolve=>{finish=()=>{calls.push('persisted');resolve({submissionAllowed:true,preparationToken:'fixture'});};});},markNotSubmitted:()=>{throw Error('successful input cannot release its receipt');}};
  const driver=createReceiptUiDriver({native,receipts,inputAllowed:()=>true}),pending=driver.submit({},{});
  await Promise.resolve();assert.deepEqual(calls,['read-only','baseline']);
  finish();assert.deepEqual(await pending,{performed:true,attempted:true});assert.deepEqual(calls,['read-only','baseline','persisted','input']);
});

test('receipt barrier joins pending preparation after an early observation refusal or unknown exception',async()=>{
  for(const unknown of [false,true]){
    let finish,settled=false,discarded=0;const failure=Object.assign(Error('unknown native result'),{code:'UI_QT_OPERATION_FAILED'});
    const driver=createReceiptUiDriver({native:{textSubmitPreparationPolicy:'receipt-barrier-v1',submit:async()=>{if(unknown)throw failure;return{performed:false,attempted:false,reason:'UI_QT_HEADER_CHANGED'};}},inputAllowed:()=>true,
      receipts:{prepare:()=>new Promise(resolve=>{finish=resolve;}),markNotSubmitted:async()=>{discarded++;return{notSubmitted:true};}}});
    const pending=driver.submit({},{});pending.then(()=>{settled=true;},()=>{settled=true;});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);assert.equal(discarded,0);
    finish({submissionAllowed:true,preparationToken:'fixture'});
    if(unknown)await assert.rejects(pending,error=>error===failure);else assert.equal((await pending).attempted,false);
    assert.equal(discarded,unknown?0:1);
  }
});

test('receipt barrier refuses failed or already-reserved preparations without native input or releasing another reservation',async()=>{
  for(const kind of ['failed','reserved']){
    let inputs=0,discarded=0;
    const driver=createReceiptUiDriver({inputAllowed:()=>true,native:{textSubmitPreparationPolicy:'receipt-barrier-v1',async submit(_job,_guard,local){
      try{await local.beforeSubmit();}catch(error){return{performed:false,attempted:false,reason:error.code};}
      inputs++;return{performed:true,attempted:true};
    }},receipts:{prepare:async()=>{if(kind==='failed')throw Object.assign(Error('Reader failed'),{code:'UI_RECEIPT_HTTP_FAILED'});return{submissionAllowed:false};},markNotSubmitted:async()=>{discarded++;return{notSubmitted:true};}}});
    await assert.rejects(driver.submit({},{}),{code:kind==='failed'?'UI_RECEIPT_HTTP_FAILED':'UI_RECEIPT_ATTEMPT_ALREADY_PREPARED'});
    assert.equal(inputs,0);assert.equal(discarded,0);
  }
});

test('receipt barrier retains revoked, closed and aborted submissions as definite native refusals',async()=>{
  for(const kind of ['revoked','closed','aborted']){
    const abort=new AbortController();let finish,allowed=true,inputs=0,discarded=0;
    const native={textSubmitPreparationPolicy:'receipt-barrier-v1',close(){},async submit(_job,_guard,local){
      try{await local.beforeSubmit();}catch(error){return{performed:false,attempted:false,reason:error.code};}
      if(!local.canSubmit())return{performed:false,attempted:false,reason:'UI_SUBMISSION_REVOKED'};
      inputs++;return{performed:true,attempted:true};
    }};
    const driver=createReceiptUiDriver({native,inputAllowed:()=>allowed,receipts:{prepare:(_job,options)=>{assert.equal(options.signal,abort.signal);return new Promise(resolve=>{finish=resolve;});},markNotSubmitted:async()=>{discarded++;return{notSubmitted:true};}}});
    const pending=driver.submit({},{signal:abort.signal});await Promise.resolve();
    if(kind==='revoked')allowed=false;else if(kind==='closed')driver.close();else abort.abort();
    finish({submissionAllowed:true,preparationToken:'fixture'});assert.equal((await pending).attempted,false);assert.equal(inputs,0);assert.equal(discarded,1);
  }
});

test('receipt barrier capability cannot report success without awaiting exactly one grant',async()=>{
  for(const kind of ['omitted','reused','unawaited']){
    let finish,discarded=0;
    const driver=createReceiptUiDriver({inputAllowed:()=>true,native:{textSubmitPreparationPolicy:'receipt-barrier-v1',async submit(_job,_guard,local){
      if(kind==='reused'){await local.beforeSubmit();try{await local.beforeSubmit();}catch{}}
      if(kind==='unawaited')local.beforeSubmit();
      return{performed:true,attempted:true};
    }},receipts:{prepare:()=>new Promise(resolve=>{finish=resolve;}),markNotSubmitted:async()=>{discarded++;return{notSubmitted:true};}}});
    const pending=driver.submit({},{});await new Promise(resolve=>setImmediate(resolve));finish({submissionAllowed:true,preparationToken:'fixture'});
    await assert.rejects(pending,{code:'UI_RECEIPT_BARRIER_UNCONFIRMED'});assert.equal(discarded,0);
  }
});

test('final native guard gets fresh config after its own async preparation for both paste and submit',async()=>{
  for(const action of ['pasteText','submit']){
    let reads=0,allowed=true,inputs=0,discarded=0;
    const scope=createSynchronousUiConfigScope(()=>{reads++;return {allowed};});
    const native={close(){},[action]:async(_job,guard,local)=>{
      assert.equal(Object.hasOwn(guard,'canInput'),false);assert.equal(Object.hasOwn(guard,'canSubmit'),false);
      await Promise.resolve();allowed=false;
      if(!local[action==='submit'?'canSubmit':'canInput']())return {performed:false,attempted:false,reason:'UI_INPUT_REVOKED'};
      inputs++;return {performed:true,attempted:true};
    }};
    const driver=createReceiptUiDriver({native,authorizationScope:scope.run,inputAllowed:()=>scope.read().allowed,
      receipts:{prepare:async()=>({submissionAllowed:true,preparationToken:'fixture'}),markNotSubmitted:async()=>{discarded++;return {notSubmitted:true};}}});
    const result=await driver[action]({}, {[action==='submit'?'canSubmit':'canInput']:()=>scope.read().allowed});
    assert.equal(result.attempted,false);assert.equal(inputs,0);assert.equal(reads,action==='submit'?3:2);assert.equal(discarded,action==='submit'?1:0);
  }
});

test('native pre-input refusal is recorded before resumption; uncertain input keeps the preparation reserved', async () => {
  const calls = [];
  let refusal = { performed: false, attempted: false, reason: 'UI_USER_ACTIVE' }, allowed = true;
  const native = { submit: async () => { calls.push('native'); if (refusal instanceof Error) throw refusal; return refusal; }, close() {} };
  const receipts = { prepare: async () => { calls.push('prepare'); return { submissionAllowed: true, preparationToken: 'fixture-token' }; },
    markNotSubmitted: async (_job, evidence) => { assert.equal(evidence.preparationToken, 'fixture-token'); calls.push('record-refusal'); return { notSubmitted: true }; } };
  const driver = createReceiptUiDriver({ native, receipts, inputAllowed: () => allowed });
  assert.equal((await driver.submit({}, {})).attempted, false);
  assert.deepEqual(calls, ['prepare','native','record-refusal']);
  calls.length = 0; refusal = new Error('unknown');
  await assert.rejects(driver.submit({}, {}), /unknown/); assert.deepEqual(calls, ['prepare','native']);
  calls.length = 0; allowed = false;
  assert.equal((await driver.submit({}, {})).attempted, false); assert.deepEqual(calls, []);
  allowed = true; receipts.prepare = async () => { allowed = false; calls.push('prepare'); return { submissionAllowed: true, preparationToken: 'fixture-token' }; };
  assert.equal((await driver.submit({}, {})).attempted, false); assert.deepEqual(calls, ['prepare','record-refusal']);
});

test('target revocation, pause, stop and disconnect during preparation never reach native submit', async t => {
  class FakeWebSocket extends EventTarget {
    constructor() { super(); this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    send() {}
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  for (const interruption of ['target', 'pause', 'stop', 'disconnect']) {
    const f = fixture(t); f.state.ready = true;
    const native = { ...f.driver }, calls = [];
    let finishPreparation;
    const receipts = {
      prepare: async () => { calls.push('prepare'); return new Promise(resolve => { finishPreparation = resolve; }); },
      markNotSubmitted: async (job, evidence) => {
        assert.equal(job.id, id); assert.equal(evidence.preparationToken, 'fixture-token');
        assert.equal(evidence.nativeResult.performed, false); assert.equal(evidence.nativeResult.attempted, false);
        assert.equal(f.backend.outbox.get(id).state, 'submitting', 'refusal must be recorded before resumption');
        calls.push('record-refusal'); return { notSubmitted: true };
      },
    };
    const composed = createReceiptUiDriver({ native, receipts, inputAllowed: (_submit, job) => { assert.equal(job.id, id); return true; } });
    f.driver.submit = composed.submit; f.driver.close = composed.close;
    let connection;
    if (interruption === 'disconnect') {
      connection = new UiOneBotConnection({ backend: f.backend, url: 'ws://127.0.0.1:1/ws', WebSocketImpl: FakeWebSocket });
      t.after(() => connection.stop()); await connection.start();
    }
    await f.backend.action(f.request()); await f.backend.tick(); await f.backend.tick();
    const pending = f.backend.tick(); await until(() => !!finishPreparation);
    if (interruption === 'target') f.policy.targets = [];
    else if (interruption === 'pause') f.backend.outbox.pause();
    else if (interruption === 'stop') f.backend.stop();
    else connection.socket.close();
    finishPreparation({ submissionAllowed: true, preparationToken: 'fixture-token' });
    await pending;
    assert.equal(f.actions.includes('submit'), false, interruption);
    assert.deepEqual(calls, ['prepare', 'record-refusal'], interruption);
    assert.equal(f.backend.outbox.get(id).state, 'paused', interruption);
  }
});

test('a configuration check failure after preparation is durably recorded as a definite pre-input refusal', async () => {
  const job = { id, account: 'fixture-account', target: 'filehelper' }, calls = [];
  let prepared = false;
  const driver = createReceiptUiDriver({
    native: { submit: async () => { calls.push('native'); }, close() {} },
    receipts: {
      prepare: async () => { prepared = true; calls.push('prepare'); return { submissionAllowed: true, preparationToken: 'fixture-token' }; },
      markNotSubmitted: async (_job, evidence) => { assert.equal(evidence.nativeResult.reason, 'UI_INPUT_GUARD_FAILED'); calls.push('record-refusal'); return { notSubmitted: true }; },
    },
    inputAllowed: (submit, current) => { assert.equal(submit, true); assert.equal(current, job); if (prepared) throw Error('fixture config is unreadable'); return true; },
  });
  const result = await driver.submit(job, {});
  assert.deepEqual(result, { performed: false, attempted: false, reason: 'UI_INPUT_GUARD_FAILED' });
  assert.deepEqual(calls, ['prepare', 'record-refusal']);
});

test('refusal persistence failure propagates and the local policy callback never enters native payload', async () => {
  const calls = [];
  let permitted = true, failPersistence = true;
  const native = { submit: async (_job, guard) => { assert.equal(Object.hasOwn(guard, 'canSubmit'), false); calls.push('native'); return { performed: true }; }, close() {} };
  const receipts = {
    prepare: async () => { calls.push('prepare'); permitted = !failPersistence; return { submissionAllowed: true, preparationToken: 'fixture-token' }; },
    markNotSubmitted: async () => { calls.push('record-refusal'); throw Error('fixture disk failure'); },
  };
  const driver = createReceiptUiDriver({ native, receipts, inputAllowed: () => true });
  await assert.rejects(driver.submit({}, { canSubmit: () => permitted }), /fixture disk failure/);
  assert.deepEqual(calls, ['prepare', 'record-refusal']);
  permitted = true; failPersistence = false; calls.length = 0;
  assert.deepEqual(await driver.submit({}, { canSubmit: () => permitted, expectedDraft: 'fixture' }), { performed: true });
  assert.deepEqual(calls, ['prepare', 'native']);
});

test('a failed refusal record leaves the outbox querying its original intention without another native attempt', async t => {
  const f = fixture(t); f.state.ready = true;
  const targets = structuredClone(f.policy.targets), native = { ...f.driver }, calls = [];
  const composed = createReceiptUiDriver({ native, inputAllowed: () => true, receipts: {
    prepare: async () => { calls.push('prepare'); f.policy.targets = []; return { submissionAllowed: true, preparationToken: 'fixture-token' }; },
    markNotSubmitted: async () => { calls.push('record-refusal'); throw Error('fixture disk failure'); },
  } });
  f.driver.submit = composed.submit; f.driver.close = composed.close;
  f.driver.receipt = async () => { calls.push('receipt'); return { confirmed: false }; };
  await f.backend.action(f.request()); await f.backend.tick(); await f.backend.tick(); await f.backend.tick();
  assert.equal(f.backend.outbox.get(id).state, 'submitting');
  assert.equal(f.backend.outbox.get(id).reason, 'UI_SUBMISSION_UNCERTAIN');
  f.policy.targets = targets;
  await f.backend.tick(); await f.backend.tick();
  assert.equal(f.actions.includes('submit'), false);
  assert.deepEqual(calls, ['prepare', 'record-refusal', 'receipt', 'receipt']);
});

test('backend carries paste preference through preparation and optional batch input with one submit',async t=>{
  const plan={allowed:true,executionMode:'foreground',requiresForeground:true,requiresActivityGuard:true,textEntryMode:'paste'};
  const f=fixture(t,{currentPlan:()=>plan}),preparations=[];f.state.ready=true;
  f.driver.prepare=async(_job,options)=>{preparations.push(options.textEntryMode);return {ready:true};};
  f.driver.pasteText=async(_job,guard)=>{assert.equal(guard.canInput(),true);assert.equal(guard.expectedDraft,f.state.draft);f.actions.push('paste');f.state.draft+=guard.text;return{performed:true,attempted:true};};
  f.restart();await f.backend.action(f.request());for(let i=0;i<5;i++)await f.backend.tick();
  assert.deepEqual(f.actions,['paste','submit']);assert.ok(preparations.length>0);assert.ok(preparations.every(value=>value==='paste'));
  assert.equal(f.backend.outbox.get(id).state,'confirmed');
});

test('OCR handoff keeps fast navigation separate from humanized message entry',async t=>{
  const plan={allowed:true,executionMode:'foreground',sendMode:'focus-handoff',requiresForeground:true,requiresActivityGuard:true,textEntryMode:'humanized'};
  const f=fixture(t,{currentPlan:()=>plan}),preparations=[];f.state.ready=true;
  f.driver.prepare=async(_job,options)=>{preparations.push(options);return {ready:true};};
  f.driver.pasteText=async()=>{throw Error('OCR message body must not use batch paste');};
  f.restart();await f.backend.action(f.request());for(let i=0;i<20&&f.backend.outbox.get(id)?.state!=='confirmed';i++)await f.backend.tick();
  assert.equal(f.backend.outbox.get(id).state,'confirmed');assert.ok(f.actions.filter(a=>a==='type').length>1);assert.equal(f.actions.filter(a=>a==='submit').length,1);
  assert.ok(preparations.length);for(const options of preparations){assert.equal(options.textEntryMode,'humanized');assert.equal(options.interactionPlan.sendMode,'focus-handoff');}
});

test('receipt paste wrapper retains dynamic authorization without putting callbacks in native data',async()=>{
  let allowed=true,permitted=true,calls=0,check;
  const native={pasteText:async(_job,guard,local)=>{calls++;assert.equal(Object.hasOwn(guard,'canInput'),false);check=local.canInput;return{performed:true};},close(){}};
  const driver=createReceiptUiDriver({native,receipts:{},inputAllowed:()=>allowed});
  await driver.pasteText({id},{text:'测试',canInput:()=>permitted});assert.equal(calls,1);assert.equal(check(),true);
  permitted=false;assert.equal(check(),false);assert.equal((await driver.pasteText({id},{canInput:()=>false})).attempted,false);assert.equal(calls,1);
  permitted=true;allowed=false;assert.equal(check(),false);assert.equal((await driver.pasteText({id},{})).attempted,false);
  allowed=true;driver.close();assert.equal(check(),false);
});

test('receipt type wrapper preserves live authorization outside native request data',async()=>{
  let allowed=true,permitted=true,calls=0,check;
  const native={typeGrapheme:async(_job,guard,local)=>{calls++;assert.equal(Object.hasOwn(guard,'canInput'),false);check=local.canInput;return{performed:true};},close(){}};
  const driver=createReceiptUiDriver({native,receipts:{},inputAllowed:()=>allowed});
  await driver.typeGrapheme({id},{text:'字',canInput:()=>permitted});assert.equal(calls,1);assert.equal(check(),true);
  permitted=false;assert.equal(check(),false);assert.equal((await driver.typeGrapheme({id},{canInput:()=>false})).attempted,false);assert.equal(calls,1);
  permitted=true;allowed=false;assert.equal(check(),false);allowed=true;driver.close();assert.equal(check(),false);
});

test('type guard reflects pause, cancellation and target revocation during preparation',async t=>{
  for(const change of ['pause','cancel','target']){
    const f=fixture(t);f.state.ready=true;
    f.driver.typeGrapheme=async(job,guard)=>{assert.equal(guard.canInput(),true);if(change==='pause')f.backend.outbox.pause();else if(change==='cancel')f.backend.outbox.cancel(job.id);else f.policy.targets=[];assert.equal(guard.canInput(),false);return{performed:false,attempted:false,reason:'UI_INPUT_REVOKED'};};
    f.restart();await f.backend.action(f.request());await f.backend.tick();
    const result=f.backend.outbox.get(id);assert.equal(result.index,0);if(change!=='cancel')assert.equal(result.pendingInput,undefined);
    assert.equal(f.actions.length,0);
  }
});

test('paste guard observes pause or target revocation during native preparation',async t=>{
  for(const change of ['pause','target']){
    const plan={allowed:true,executionMode:'foreground',requiresForeground:true,requiresActivityGuard:true,textEntryMode:'paste'};
    const f=fixture(t,{currentPlan:()=>plan});f.state.ready=true;
    f.driver.pasteText=async(_job,guard)=>{assert.equal(guard.canInput(),true);if(change==='pause')f.backend.outbox.pause();else f.policy.targets=[];assert.equal(guard.canInput(),false);return{performed:false,attempted:false,reason:'UI_INPUT_REVOKED'};};
    f.restart();await f.backend.action(f.request());await f.backend.tick();assert.equal(f.backend.outbox.get(id).pendingInput,undefined);assert.equal(f.actions.length,0);
  }
});

test('shared voice checks the read-only gate after permissions and keeps full preparation in its transport',async t=>{
  const voice={allowed:true,executionMode:'focus-handoff',requiresForeground:true,requiresActivityGuard:true,activityGuardScope:'handoff-only'};
  const text={allowed:true,executionMode:'foreground',requiresForeground:true,requiresActivityGuard:true,textEntryMode:'paste'};
  const voiceOutbox={get(){return null;},close(){}};
  const f=fixture(t,{currentPlan:()=>text,currentVoicePlan:()=>voice,voiceOutbox,modeFor:()=> 'voice'});let prepared=0,preflight=0,ready=true;
  f.driver.prepare=async(_job,options)=>{prepared++;assert.equal(options.textEntryMode,'paste');return{ready:true};};f.restart();
  const job={id,account:f.policy.accountWxid,target:'filehelper',mode:'voice'};
  assert.equal((await f.backend.outbox.prepare(job,{})).reason,'UI_FOCUS_HANDOFF_UNAVAILABLE');assert.equal(prepared,0);
  f.driver.prepareVoiceHandoff=async()=>{preflight++;return{ready,reason:ready?null:'QT_USER_ACTIVE'};};f.restart();
  ready=false;assert.equal((await f.backend.outbox.prepare(job,{})).reason,'QT_USER_ACTIVE');assert.equal(prepared,0);assert.equal(preflight,1);
  ready=true;assert.equal((await f.backend.outbox.prepare(job,{})).ready,true);assert.equal(prepared,0);assert.equal(preflight,2);
  assert.equal((await f.backend.outbox.prepare({...job,mode:'text'},{})).ready,true);assert.equal(prepared,1);
  voice.executionMode='foreground';assert.equal((await f.backend.outbox.prepare(job,{})).reason,'UI_INTERACTION_PLAN_BLOCKED');assert.equal(prepared,1);
  voice.allowed=false;assert.equal((await f.backend.outbox.prepare(job,{})).reason,'UI_INTERACTION_PLAN_BLOCKED');assert.equal(prepared,1);
  voice.allowed=true;voice.executionMode='focus-handoff';f.policy.targets=[];
  assert.equal((await f.backend.outbox.prepare(job,{})).ready,false);assert.equal(prepared,1);assert.equal(preflight,2);
});

test('handoff preflight wrapper respects closed, input-disabled and aborted states without native calls',async()=>{
  let allowed=true,calls=0;const native={prepareVoiceHandoff:async()=>{calls++;return{ready:true};},close(){}};
  const driver=createReceiptUiDriver({native,receipts:{},inputAllowed:()=>allowed});
  assert.equal((await driver.prepareVoiceHandoff({},{})).ready,true);assert.equal(calls,1);
  allowed=false;assert.equal((await driver.prepareVoiceHandoff({},{})).ready,false);allowed=true;
  assert.equal((await driver.prepareVoiceHandoff({},{signal:AbortSignal.abort()})).ready,false);driver.close();
  assert.equal((await driver.prepareVoiceHandoff({},{})).ready,false);assert.equal(calls,1);
});

test('busy shared preflight retains the queued reply and retries only the read-only gate',async t=>{
  const voice={allowed:true,executionMode:'focus-handoff',requiresForeground:true,requiresActivityGuard:true,activityGuardScope:'handoff-only'};
  const text={allowed:true,executionMode:'foreground',requiresForeground:true,requiresActivityGuard:true,textEntryMode:'paste'};
  let voiceRuns=0,gates=0,ready=false,release,reason='QT_ACTIVITY_WARMUP',now=10000;
  const voiceOutbox={get(){return null;},close(){},async run(){voiceRuns++;}};
  const f=fixture(t,{currentPlan:()=>text,currentVoicePlan:()=>voice,voiceOutbox,modeFor:()=> 'voice',now:()=>now});
  f.driver.prepareVoiceHandoff=async()=>{gates++;return{ready,reason};};f.restart();const voiceRequest=f.request();voiceRequest.params.wechatagent_reply_mode='voice';await f.backend.action(voiceRequest);
  await f.backend.tick();assert.equal(f.backend.lastObservation.reason,'QT_ACTIVITY_WARMUP');reason='QT_USER_ACTIVE';await f.backend.tick();assert.equal(gates,1);now+=1000;await f.backend.tick();assert.equal(f.backend.outbox.get(id).state,'queued');assert.equal(f.backend.lastObservation.reason,'QT_USER_ACTIVE');assert.equal(voiceRuns,0);assert.equal(gates,2);
  ready=true;now+=2000;await f.backend.tick();assert.equal(voiceRuns,1);
  f.driver.prepareVoiceHandoff=async()=>new Promise(done=>{release=done;});const pending=f.backend.tick();await until(()=>release);
  f.policy.targets=[];release({ready:true});await pending;assert.equal(voiceRuns,1);
});
